/**
 * @typedef {Error & { brokerFatal?: boolean, code?: string, data?: unknown, rpcCode?: number, transport?: string }} ProtocolError
 * @typedef {import("./app-server-protocol").AppServerMethod} AppServerMethod
 * @typedef {import("./app-server-protocol").AppServerNotification} AppServerNotification
 * @typedef {import("./app-server-protocol").AppServerNotificationHandler} AppServerNotificationHandler
 * @typedef {import("./app-server-protocol").ClientInfo} ClientInfo
 * @typedef {import("./app-server-protocol").CodexAppServerClientOptions} CodexAppServerClientOptions
 * @typedef {import("./app-server-protocol").InitializeCapabilities} InitializeCapabilities
 */
import fs from "node:fs";
import net from "node:net";
import process from "node:process";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { parseBrokerEndpoint } from "./broker-endpoint.mjs";
import { ensureBrokerSession, loadBrokerSession } from "./broker-lifecycle.mjs";
import { codexBinaryRequiresShell, resolveCodexBinary, terminateProcessTree } from "./process.mjs";

const PLUGIN_MANIFEST_URL = new URL("../../.claude-plugin/plugin.json", import.meta.url);
const PLUGIN_MANIFEST = JSON.parse(fs.readFileSync(PLUGIN_MANIFEST_URL, "utf8"));

export const BROKER_ENDPOINT_ENV = "CODEX_COMPANION_APP_SERVER_ENDPOINT";
export const BROKER_OPT_IN_ENV = "CODEX_COMPANION_USE_BROKER";
export const BROKER_BUSY_RPC_CODE = -32001;
export const REQUEST_TIMEOUT_CODE = "EBROKERTIMEOUT";
export const REQUEST_TIMEOUT_ENV = "CODEX_COMPANION_APP_SERVER_REQUEST_TIMEOUT_MS";
export const INITIALIZE_TIMEOUT_ENV = "CODEX_COMPANION_APP_SERVER_INITIALIZE_TIMEOUT_MS";
export const CLOSE_TIMEOUT_ENV = "CODEX_COMPANION_APP_SERVER_CLOSE_TIMEOUT_MS";
export const BROKER_CONNECT_TIMEOUT_ENV = "CODEX_COMPANION_BROKER_CONNECT_TIMEOUT_MS";

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_INITIALIZE_TIMEOUT_MS = 30_000;
const DEFAULT_BROKER_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 5_000;
const MUTATING_METHODS = new Set([
  "thread/start",
  "thread/resume",
  "thread/name/set",
  "turn/start",
  "review/start"
]);

/** @type {ClientInfo} */
const DEFAULT_CLIENT_INFO = {
  title: "Codex Plugin",
  name: "Claude Code",
  version: PLUGIN_MANIFEST.version ?? "0.0.0"
};

/** @type {InitializeCapabilities} */
const DEFAULT_CAPABILITIES = {
  experimentalApi: false,
  requestAttestation: false,
  optOutNotificationMethods: [
    "item/agentMessage/delta",
    "item/reasoning/summaryTextDelta",
    "item/reasoning/summaryPartAdded",
    "item/reasoning/textDelta"
  ]
};

function buildJsonRpcError(code, message, data) {
  return data === undefined ? { code, message } : { code, message, data };
}

function createProtocolError(message, data) {
  const error = /** @type {ProtocolError} */ (new Error(message));
  error.data = data;
  if (data?.code !== undefined) {
    error.rpcCode = data.code;
  }
  return error;
}

function resolveTimeoutMs(optionValue, envValue, fallback) {
  const parsed = Number(optionValue ?? envValue);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function waitForPromise(promise, timeoutMs) {
  let timer;
  return Promise.race([
    promise.then(() => true),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    })
  ]).finally(() => clearTimeout(timer));
}

function createRequestTimeoutError(method, transport) {
  const error = /** @type {ProtocolError} */ (new Error(`codex app-server ${method} timed out.`));
  error.code = REQUEST_TIMEOUT_CODE;
  error.transport = transport;
  return error;
}

class AppServerClientBase {
  constructor(cwd, options = {}) {
    this.cwd = cwd;
    this.options = options;
    this.pending = new Map();
    this.nextId = 1;
    this.stderr = "";
    this.closed = false;
    this.exitError = null;
    /** @type {AppServerNotificationHandler | null} */
    this.notificationHandler = null;
    this.lineBuffer = "";
    this.transport = "unknown";
    this.hasAcceptedMutation = false;
    const env = options.env ?? process.env;
    this.requestTimeoutMs = resolveTimeoutMs(options.requestTimeoutMs, env[REQUEST_TIMEOUT_ENV], DEFAULT_REQUEST_TIMEOUT_MS);
    this.closeTimeoutMs = resolveTimeoutMs(options.closeTimeoutMs, env[CLOSE_TIMEOUT_ENV], DEFAULT_CLOSE_TIMEOUT_MS);

    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
  }

  setNotificationHandler(handler) {
    this.notificationHandler = handler;
  }

  /**
   * @template {AppServerMethod} M
   * @param {M} method
   * @param {import("./app-server-protocol").AppServerRequestParams<M>} params
   * @param {{ timeoutMs?: number, onTimeout?: (error: ProtocolError) => void }} [options]
   * @returns {Promise<import("./app-server-protocol").AppServerResponse<M>>}
   */
  request(method, params, options = {}) {
    if (this.closed || this.exitResolved) {
      throw new Error("codex app-server client is closed.");
    }

    const id = this.nextId;
    this.nextId += 1;

    return new Promise((resolve, reject) => {
      const timeoutMs = resolveTimeoutMs(options.timeoutMs, null, this.requestTimeoutMs);
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) {
          return;
        }
        const error = createRequestTimeoutError(method, this.transport);
        try {
          options.onTimeout?.(error);
        } catch {
          // Timeout cleanup is best-effort; the timeout itself remains observable.
        }
        reject(error);
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, method, timer });
      try {
        this.sendMessage({ id, method, params });
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  notify(method, params = {}) {
    if (this.closed || this.exitResolved) {
      return;
    }
    this.sendMessage({ method, params });
  }

  handleChunk(chunk) {
    this.lineBuffer += chunk;
    let newlineIndex = this.lineBuffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.lineBuffer.slice(0, newlineIndex);
      this.lineBuffer = this.lineBuffer.slice(newlineIndex + 1);
      this.handleLine(line);
      newlineIndex = this.lineBuffer.indexOf("\n");
    }
  }

  handleLine(line) {
    if (!line.trim()) {
      return;
    }

    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.handleExit(createProtocolError(`Failed to parse codex app-server JSONL: ${error.message}`, { line }));
      return;
    }

    if (message.id !== undefined && message.method) {
      this.handleServerRequest(message);
      return;
    }

    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      clearTimeout(pending.timer);

      if (message.error) {
        pending.reject(createProtocolError(message.error.message ?? `codex app-server ${pending.method} failed.`, message.error));
      } else {
        if (MUTATING_METHODS.has(pending.method)) {
          this.hasAcceptedMutation = true;
        }
        pending.resolve(message.result ?? {});
      }
      return;
    }

    if (message.method && this.notificationHandler) {
      this.notificationHandler(/** @type {AppServerNotification} */ (message));
    }
  }

  handleServerRequest(message) {
    this.sendMessage({
      id: message.id,
      error: buildJsonRpcError(-32601, `Unsupported server request: ${message.method}`)
    });
  }

  handleExit(error) {
    if (this.exitResolved) {
      return;
    }

    this.exitResolved = true;
    this.exitError = error ?? null;

    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(this.exitError ?? new Error("codex app-server connection closed."));
    }
    this.pending.clear();
    this.resolveExit(undefined);
  }

  sendMessage(_message) {
    throw new Error("sendMessage must be implemented by subclasses.");
  }
}

class SpawnedCodexAppServerClient extends AppServerClientBase {
  constructor(cwd, options = {}) {
    super(cwd, options);
    this.transport = "direct";
  }

  async initialize() {
    const env = this.options.env ?? process.env;
    const codexBinary = resolveCodexBinary(env);
    this.proc = spawn(codexBinary, ["app-server"], {
      cwd: this.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: codexBinaryRequiresShell(codexBinary),
      windowsHide: true
    });

    this.proc.stdout.setEncoding("utf8");
    this.proc.stderr.setEncoding("utf8");

    this.proc.stderr.on("data", (chunk) => {
      this.stderr += chunk;
    });

    this.proc.stdin.on("error", (error) => {
      this.handleExit(error);
    });

    this.proc.on("error", (error) => {
      this.handleExit(error);
    });

    this.proc.on("exit", (code, signal) => {
      const stderr = this.stderr.trim();
      const detail =
        code === 0
          ? null
          : createProtocolError(
              `codex app-server exited unexpectedly (${signal ? `signal ${signal}` : `exit ${code}`}).${stderr ? `\n${stderr}` : ""}`
            );
      this.handleExit(detail);
    });

    this.readline = readline.createInterface({ input: this.proc.stdout });
    this.readline.on("line", (line) => {
      this.handleLine(line);
    });

    const initializeTimeoutMs = resolveTimeoutMs(
      this.options.spawnedInitializeTimeoutMs,
      env[INITIALIZE_TIMEOUT_ENV],
      DEFAULT_INITIALIZE_TIMEOUT_MS
    );
    try {
      await this.request("initialize", {
        clientInfo: this.options.clientInfo ?? DEFAULT_CLIENT_INFO,
        capabilities: this.options.capabilities ?? DEFAULT_CAPABILITIES
      }, {
        timeoutMs: initializeTimeoutMs,
        onTimeout: () => this.killChildNow()
      });
    } catch (error) {
      this.killChildNow();
      this.handleExit(error);
      throw error;
    }
    this.notify("initialized", {});
  }

  childIsRunning() {
    return Boolean(this.proc && this.proc.exitCode === null && this.proc.signalCode === null);
  }

  killChildNow(force = false) {
    if (!this.childIsRunning()) {
      return;
    }
    try {
      if (process.platform === "win32") {
        terminateProcessTree(this.proc.pid);
      } else {
        this.proc.kill(force ? "SIGKILL" : "SIGTERM");
      }
    } catch {
      // The child may have exited between the liveness check and the signal.
    }
  }

  async close() {
    if (this.closed) {
      return;
    }

    this.closed = true;

    if (this.exitResolved) {
      return;
    }

    if (this.readline) {
      this.readline.close();
    }

    if (this.proc?.stdin && !this.proc.stdin.destroyed) {
      try {
        this.proc.stdin.end();
      } catch {
        // Continue to the owned-child termination path below.
      }
    }

    const gracefulWaitMs = Math.min(100, this.closeTimeoutMs);
    if (await waitForPromise(this.exitPromise, gracefulWaitMs)) {
      return;
    }

    this.killChildNow();
    const remainingWaitMs = Math.max(1, this.closeTimeoutMs - gracefulWaitMs);
    if (await waitForPromise(this.exitPromise, remainingWaitMs)) {
      return;
    }

    this.killChildNow(true);
    this.handleExit(createProtocolError("codex app-server did not exit before the shutdown deadline."));
  }

  sendMessage(message) {
    const line = `${JSON.stringify(message)}\n`;
    const stdin = this.proc?.stdin;
    if (!stdin) {
      throw new Error("codex app-server stdin is not available.");
    }
    stdin.write(line);
  }
}

class BrokerCodexAppServerClient extends AppServerClientBase {
  constructor(cwd, options = {}) {
    super(cwd, options);
    this.transport = "broker";
    this.endpoint = options.brokerEndpoint;
  }

  async initialize() {
    const env = this.options.env ?? process.env;
    const connectTimeoutMs = resolveTimeoutMs(
      this.options.brokerConnectTimeoutMs,
      env[BROKER_CONNECT_TIMEOUT_ENV],
      DEFAULT_BROKER_CONNECT_TIMEOUT_MS
    );
    const initializeTimeoutMs = resolveTimeoutMs(
      this.options.brokerInitializeTimeoutMs,
      env[INITIALIZE_TIMEOUT_ENV],
      DEFAULT_INITIALIZE_TIMEOUT_MS
    );

    try {
      await new Promise((resolve, reject) => {
        const target = parseBrokerEndpoint(this.endpoint);
        this.socket = net.createConnection({ path: target.path });
        this.socket.setEncoding("utf8");
        const timer = setTimeout(() => {
          const error = createRequestTimeoutError("broker connect", this.transport);
          reject(error);
          this.socket.destroy(error);
        }, connectTimeoutMs);
        timer.unref?.();
        this.socket.once("connect", () => {
          clearTimeout(timer);
          resolve();
        });
        this.socket.on("data", (chunk) => {
          this.handleChunk(chunk);
        });
        this.socket.on("error", (error) => {
          clearTimeout(timer);
          if (!this.exitResolved) {
            reject(error);
          }
          this.handleExit(error);
        });
        this.socket.on("close", () => {
          clearTimeout(timer);
          this.handleExit(this.exitError);
        });
      });

      await this.request("initialize", {
        clientInfo: this.options.clientInfo ?? DEFAULT_CLIENT_INFO,
        capabilities: this.options.capabilities ?? DEFAULT_CAPABILITIES
      }, {
        timeoutMs: initializeTimeoutMs,
        onTimeout: (error) => this.socket?.destroy(error)
      });
    } catch (error) {
      this.socket?.destroy();
      this.handleExit(error);
      throw error;
    }
    this.notify("initialized", {});
  }

  async close() {
    if (this.closed) {
      return;
    }

    this.closed = true;
    if (this.exitResolved) {
      return;
    }
    if (this.socket) {
      this.socket.end();
    }
    if (await waitForPromise(this.exitPromise, this.closeTimeoutMs)) {
      return;
    }
    const error = createProtocolError("codex app-server broker did not close before the shutdown deadline.");
    this.socket?.destroy(error);
    this.handleExit(error);
  }

  sendMessage(message) {
    const line = `${JSON.stringify(message)}\n`;
    const socket = this.socket;
    if (!socket) {
      throw new Error("codex app-server broker connection is not connected.");
    }
    socket.write(line);
  }
}

export class CodexAppServerClient {
  static async connect(cwd, options = {}) {
    let brokerEndpoint = null;
    const env = options.env ?? process.env;
    const configuredEndpoint = options.brokerEndpoint ?? env[BROKER_ENDPOINT_ENV] ?? null;
    const brokerOptedIn = options.useBroker === true || env[BROKER_OPT_IN_ENV] === "1" || Boolean(configuredEndpoint);
    if (!options.disableBroker && (brokerOptedIn || options.reuseExistingBroker)) {
      brokerEndpoint = configuredEndpoint;
      if (!brokerEndpoint && options.reuseExistingBroker) {
        brokerEndpoint = loadBrokerSession(cwd)?.endpoint ?? null;
      }
      if (!brokerEndpoint && brokerOptedIn && !options.reuseExistingBroker) {
        const brokerSession = await ensureBrokerSession(cwd, {
          env,
          timeoutMs: options.brokerStartTimeoutMs
        });
        brokerEndpoint = brokerSession?.endpoint ?? null;
      }
    }
    const client = brokerEndpoint
      ? new BrokerCodexAppServerClient(cwd, { ...options, brokerEndpoint })
      : new SpawnedCodexAppServerClient(cwd, options);
    try {
      await client.initialize();
      return client;
    } catch (error) {
      if (error && typeof error === "object") {
        error.transport ??= client.transport;
        if (client.transport === "broker") {
          error.brokerFatal = true;
        }
      }
      await client.close().catch(() => {});
      throw error;
    }
  }
}
