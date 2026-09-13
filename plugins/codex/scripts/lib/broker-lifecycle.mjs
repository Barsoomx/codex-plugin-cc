import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createBrokerEndpoint, parseBrokerEndpoint } from "./broker-endpoint.mjs";
import { terminateProcessTree } from "./process.mjs";
import { resolveStateDir } from "./state.mjs";

export const PID_FILE_ENV = "CODEX_COMPANION_APP_SERVER_PID_FILE";
export const LOG_FILE_ENV = "CODEX_COMPANION_APP_SERVER_LOG_FILE";
export const BROKER_SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";
export const BROKER_START_TIMEOUT_ENV = "CODEX_COMPANION_BROKER_START_TIMEOUT_MS";
export const BROKER_SHUTDOWN_TIMEOUT_ENV = "CODEX_COMPANION_BROKER_SHUTDOWN_TIMEOUT_MS";
export const BROKER_LOCK_TIMEOUT_ENV = "CODEX_COMPANION_BROKER_LOCK_TIMEOUT_MS";
export const DEFAULT_BROKER_START_TIMEOUT_MS = 30_000;
const DEFAULT_BROKER_SHUTDOWN_TIMEOUT_MS = 5_000;
const DEFAULT_BROKER_LOCK_TIMEOUT_MS = 35_000;
const DEFAULT_BROKER_CLEAR_LOCK_TIMEOUT_MS = 2_000;
const BROKER_LOCK_RECOVERY_GRACE_MS = 2_000;
const BROKER_STATE_FILE = "broker.json";
const BROKER_LOCK_DIR = "broker.lock";
const BROKER_LOCK_OWNER_FILE = "owner.json";

export function createBrokerSessionDir(prefix = "cxc-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function connectToEndpoint(endpoint) {
  const target = parseBrokerEndpoint(endpoint);
  return net.createConnection({ path: target.path });
}

function resolveTimeoutMs(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function tryBrokerEndpoint(endpoint, timeoutMs, connect = connectToEndpoint) {
  return new Promise((resolve) => {
    let socket;
    let settled = false;
    let timer;
    const finish = (ready) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(ready);
    };

    try {
      socket = connect(endpoint);
    } catch {
      finish(false);
      return;
    }

    timer = setTimeout(() => {
      socket.destroy();
      finish(false);
    }, timeoutMs);
    socket.once("connect", () => {
      socket.end();
      finish(true);
    });
    socket.once("error", () => finish(false));
  });
}

export async function waitForBrokerEndpoint(endpoint, timeoutMs = DEFAULT_BROKER_START_TIMEOUT_MS, options = {}) {
  const deadline = Date.now() + resolveTimeoutMs(timeoutMs, DEFAULT_BROKER_START_TIMEOUT_MS);
  while (Date.now() < deadline && !options.shouldStop?.()) {
    const remainingMs = deadline - Date.now();
    const ready = await tryBrokerEndpoint(endpoint, Math.min(250, remainingMs), options.connect);
    if (ready) {
      return true;
    }
    const retryDelayMs = Math.min(50, Math.max(0, deadline - Date.now()));
    if (retryDelayMs > 0 && !options.shouldStop?.()) {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
  return false;
}

export async function sendBrokerShutdown(endpoint, timeoutMs = null, options = {}) {
  return await new Promise((resolve) => {
    let socket;
    let buffer = "";
    let settled = false;
    const finish = (acknowledged) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket?.destroy();
      resolve(acknowledged);
    };
    const resolvedTimeoutMs = resolveTimeoutMs(
      timeoutMs ?? options.env?.[BROKER_SHUTDOWN_TIMEOUT_ENV] ?? process.env[BROKER_SHUTDOWN_TIMEOUT_ENV],
      DEFAULT_BROKER_SHUTDOWN_TIMEOUT_MS
    );
    const timer = setTimeout(() => finish(false), resolvedTimeoutMs);

    try {
      socket = (options.connect ?? connectToEndpoint)(endpoint);
    } catch {
      finish(false);
      return;
    }
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ id: 1, method: "broker/shutdown", params: {} })}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");
        try {
          const message = JSON.parse(line);
          if (message.id === 1 && !message.error) {
            finish(true);
            return;
          }
        } catch {
          // Ignore non-protocol data and keep waiting for the bounded deadline.
        }
      }
    });
    socket.on("error", () => finish(false));
    socket.on("close", () => finish(false));
  });
}

export function spawnBrokerProcess({ scriptPath, cwd, endpoint, pidFile, logFile, env = process.env }) {
  const logFd = fs.openSync(logFile, "a");
  let child;
  try {
    child = spawn(process.execPath, [
      scriptPath,
      "serve",
      "--endpoint",
      endpoint,
      "--cwd",
      cwd,
      "--pid-file",
      pidFile,
      "--log-file",
      logFile
    ], {
      cwd,
      env,
      detached: true,
      stdio: ["ignore", logFd, logFd]
    });
  } finally {
    fs.closeSync(logFd);
  }
  child.unref();
  return child;
}

function resolveBrokerStateFile(cwd) {
  return path.join(resolveStateDir(cwd), BROKER_STATE_FILE);
}

function resolveBrokerLockDir(cwd) {
  return path.join(resolveStateDir(cwd), BROKER_LOCK_DIR);
}

function readBrokerLockOwner(lockDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(lockDir, BROKER_LOCK_OWNER_FILE), "utf8"));
  } catch {
    return null;
  }
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function releaseBrokerLock(lockDir, token) {
  const owner = readBrokerLockOwner(lockDir);
  if (owner?.token !== token) {
    return;
  }
  try {
    fs.unlinkSync(path.join(lockDir, BROKER_LOCK_OWNER_FILE));
    fs.rmdirSync(lockDir);
  } catch {
    // A replaced or already-released lock is not ours to remove.
  }
}

function recoverDeadBrokerLock(lockDir) {
  let lockAgeMs;
  try {
    lockAgeMs = Date.now() - fs.statSync(lockDir).mtimeMs;
  } catch {
    return true;
  }

  const owner = readBrokerLockOwner(lockDir);
  if (owner?.token && processIsAlive(owner.pid)) {
    return false;
  }
  if (!owner?.token && lockAgeMs < BROKER_LOCK_RECOVERY_GRACE_MS) {
    return false;
  }

  const current = readBrokerLockOwner(lockDir);
  if (owner?.token && current?.token !== owner.token) {
    return false;
  }
  try {
    const ownerFile = path.join(lockDir, BROKER_LOCK_OWNER_FILE);
    if (fs.existsSync(ownerFile)) {
      fs.unlinkSync(ownerFile);
    }
    fs.rmdirSync(lockDir);
    return true;
  } catch {
    return false;
  }
}

async function acquireBrokerLock(cwd, timeoutMs) {
  const stateDir = resolveStateDir(cwd);
  fs.mkdirSync(stateDir, { recursive: true });
  const lockDir = resolveBrokerLockDir(cwd);
  const deadline = Date.now() + timeoutMs;
  const token = randomUUID();

  while (Date.now() < deadline) {
    try {
      fs.mkdirSync(lockDir);
      try {
        fs.writeFileSync(path.join(lockDir, BROKER_LOCK_OWNER_FILE), JSON.stringify({
          pid: process.pid,
          token,
          createdAtMs: Date.now()
        }), { encoding: "utf8", flag: "wx" });
      } catch (error) {
        try {
          fs.rmdirSync(lockDir);
        } catch {}
        throw error;
      }
      return {
        release() {
          releaseBrokerLock(lockDir, token);
        }
      };
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
    }

    if (recoverDeadBrokerLock(lockDir)) {
      continue;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(50, Math.max(1, deadline - Date.now()))));
  }
  return null;
}

export function loadBrokerSession(cwd) {
  const stateFile = resolveBrokerStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch {
    return null;
  }
}

export function saveBrokerSession(cwd, session) {
  const stateDir = resolveStateDir(cwd);
  fs.mkdirSync(stateDir, { recursive: true });
  const stateFile = resolveBrokerStateFile(cwd);
  const tempFile = `${stateFile}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  fs.writeFileSync(tempFile, `${JSON.stringify(session, null, 2)}\n`, "utf8");
  fs.renameSync(tempFile, stateFile);
}

export function clearBrokerSession(cwd) {
  const stateFile = resolveBrokerStateFile(cwd);
  try {
    if (fs.existsSync(stateFile)) {
      fs.unlinkSync(stateFile);
    }
  } catch {
    // Another lifecycle path may already have removed the state file.
  }
}

function samePath(left, right) {
  if (!left || !right) {
    return false;
  }
  const normalize = (value) => {
    let resolved = path.resolve(value);
    try {
      resolved = fs.realpathSync.native(resolved);
    } catch {
      // The endpoint or log may already have been removed during shutdown.
    }
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

function brokerSessionsMatch(current, expected) {
  return Boolean(
    current &&
    expected &&
    current.endpoint === expected.endpoint &&
    current.pid === expected.pid &&
    (!expected.pidFile || samePath(current.pidFile, expected.pidFile)) &&
    (!expected.logFile || samePath(current.logFile, expected.logFile)) &&
    (!expected.sessionDir || samePath(current.sessionDir, expected.sessionDir))
  );
}

export async function clearBrokerSessionIfOwned(cwd, expected, options = {}) {
  const env = options.env ?? process.env;
  const timeoutMs = resolveTimeoutMs(
    options.timeoutMs ?? env[BROKER_LOCK_TIMEOUT_ENV],
    DEFAULT_BROKER_CLEAR_LOCK_TIMEOUT_MS
  );
  const lock = await acquireBrokerLock(cwd, timeoutMs);
  if (!lock) {
    return false;
  }
  try {
    if (!brokerSessionsMatch(loadBrokerSession(cwd), expected)) {
      return false;
    }
    clearBrokerSession(cwd);
    return true;
  } finally {
    lock.release();
  }
}

function resolveOwnedBrokerArtifacts({ endpoint, pidFile, logFile, sessionDir, pid }) {
  if (!Number.isInteger(pid) || pid <= 0 || !pidFile || !logFile) {
    return null;
  }

  let resolvedSessionDir;
  let tempRoot;
  try {
    resolvedSessionDir = fs.realpathSync.native(path.resolve(sessionDir ?? path.dirname(pidFile)));
    tempRoot = fs.realpathSync.native(path.resolve(os.tmpdir()));
  } catch {
    return null;
  }
  if (
    !samePath(path.dirname(resolvedSessionDir), tempRoot) ||
    !path.basename(resolvedSessionDir).startsWith("cxc-") ||
    !samePath(pidFile, path.join(resolvedSessionDir, "broker.pid")) ||
    !samePath(logFile, path.join(resolvedSessionDir, "broker.log"))
  ) {
    return null;
  }

  try {
    if (Number.parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10) !== pid) {
      return null;
    }
    const target = parseBrokerEndpoint(endpoint);
    const endpointMatches = target.kind === "unix"
      ? samePath(target.path, path.join(resolvedSessionDir, "broker.sock"))
      : endpoint === createBrokerEndpoint(resolvedSessionDir, "win32");
    if (!endpointMatches) {
      return null;
    }
  } catch {
    return null;
  }

  return { sessionDir: resolvedSessionDir, pidFile, logFile, endpoint };
}

export async function cleanupOwnedBrokerSession(cwd, ownership, options = {}) {
  const artifacts = resolveOwnedBrokerArtifacts(ownership);
  if (!artifacts) {
    return { cleaned: false, registryCleared: false };
  }

  let registryCleared = false;
  let lock = null;
  try {
    const env = options.env ?? process.env;
    const timeoutMs = resolveTimeoutMs(
      options.timeoutMs ?? env[BROKER_LOCK_TIMEOUT_ENV],
      DEFAULT_BROKER_CLEAR_LOCK_TIMEOUT_MS
    );
    lock = await acquireBrokerLock(cwd, timeoutMs);
    if (lock && brokerSessionsMatch(loadBrokerSession(cwd), ownership)) {
      clearBrokerSession(cwd);
      registryCleared = true;
    }
  } catch {
    // Artifact cleanup remains safe even if the registry lock is unavailable.
  } finally {
    lock?.release();
  }

  try {
    const target = parseBrokerEndpoint(artifacts.endpoint);
    if (target.kind === "unix" && fs.existsSync(target.path)) {
      fs.unlinkSync(target.path);
    }
  } catch {
    // The broker listener may already have removed its own socket.
  }
  try {
    if (fs.existsSync(artifacts.pidFile)) {
      fs.unlinkSync(artifacts.pidFile);
    }
  } catch {
    // The PID file may already have been removed by another owned path.
  }

  try {
    if (fs.existsSync(artifacts.logFile)) {
      fs.unlinkSync(artifacts.logFile);
    }
  } catch {
    // Windows may retain the inherited log handle until process exit.
  }
  try {
    fs.rmdirSync(artifacts.sessionDir);
  } catch {
    // Preserve non-empty or concurrently replaced directories.
  }

  return { cleaned: true, registryCleared };
}

async function isBrokerEndpointReady(endpoint) {
  if (!endpoint) {
    return false;
  }
  try {
    return await waitForBrokerEndpoint(endpoint, 150);
  } catch {
    return false;
  }
}

export async function ensureBrokerSession(cwd, options = {}) {
  const env = options.env ?? process.env;
  const startupTimeoutMs = resolveTimeoutMs(
    options.timeoutMs ?? env[BROKER_START_TIMEOUT_ENV],
    DEFAULT_BROKER_START_TIMEOUT_MS
  );
  const lockTimeoutMs = resolveTimeoutMs(
    options.lockTimeoutMs ?? env[BROKER_LOCK_TIMEOUT_ENV],
    Math.max(DEFAULT_BROKER_LOCK_TIMEOUT_MS, startupTimeoutMs + 5_000)
  );
  const lock = await acquireBrokerLock(cwd, lockTimeoutMs);
  if (!lock) {
    const existing = loadBrokerSession(cwd);
    return existing && (await isBrokerEndpointReady(existing.endpoint)) ? existing : null;
  }

  try {
    const existing = loadBrokerSession(cwd);
    if (existing && (await isBrokerEndpointReady(existing.endpoint))) {
      return existing;
    }

    if (existing) {
      teardownBrokerSession({
        endpoint: existing.endpoint ?? null,
        pidFile: existing.pidFile ?? null,
        logFile: existing.logFile ?? null,
        sessionDir: existing.sessionDir ?? null,
        pid: existing.pid ?? null,
        killProcess: options.killProcess ?? null
      });
      clearBrokerSession(cwd);
    }

    const sessionDir = createBrokerSessionDir();
    const endpointFactory = options.createBrokerEndpoint ?? createBrokerEndpoint;
    const endpoint = endpointFactory(sessionDir, options.platform);
    const pidFile = path.join(sessionDir, "broker.pid");
    const logFile = path.join(sessionDir, "broker.log");
    const scriptPath =
      options.scriptPath ??
      fileURLToPath(new URL("../app-server-broker.mjs", import.meta.url));

    const child = spawnBrokerProcess({
      scriptPath,
      cwd,
      endpoint,
      pidFile,
      logFile,
      env
    });
    let childFailed = child.exitCode !== null || child.signalCode !== null;
    child.once("error", () => {
      childFailed = true;
    });
    child.once("exit", () => {
      childFailed = true;
    });

    const ready = await waitForBrokerEndpoint(endpoint, startupTimeoutMs, {
      shouldStop: () => childFailed
    });
    if (!ready) {
      teardownBrokerSession({
        endpoint,
        pidFile,
        logFile,
        sessionDir,
        pid: child.pid ?? null,
        // This PID came from the child just spawned in this call, so it is safe
        // to terminate. Stale sessions above are never killed without a caller-
        // supplied ownership check.
        killProcess: options.killProcess ?? terminateProcessTree
      });
      return null;
    }

    const session = {
      endpoint,
      pidFile,
      logFile,
      sessionDir,
      pid: child.pid ?? null,
      sessionId: env[BROKER_SESSION_ID_ENV] ?? null
    };
    saveBrokerSession(cwd, session);
    return session;
  } finally {
    lock.release();
  }
}

export function teardownBrokerSession({ endpoint = null, pidFile, logFile, sessionDir = null, pid = null, killProcess = null }) {
  if (Number.isFinite(pid) && killProcess) {
    try {
      killProcess(pid);
    } catch {
      // Ignore missing or already-exited broker processes.
    }
  }

  for (const filePath of [pidFile, logFile]) {
    try {
      if (filePath && fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch {
      // Ignore files already removed by the broker's own shutdown path.
    }
  }

  if (endpoint) {
    try {
      const target = parseBrokerEndpoint(endpoint);
      if (target.kind === "unix" && fs.existsSync(target.path)) {
        fs.unlinkSync(target.path);
      }
    } catch {
      // Ignore malformed or already-removed broker endpoints during teardown.
    }
  }

  const resolvedSessionDir = sessionDir ?? (pidFile ? path.dirname(pidFile) : logFile ? path.dirname(logFile) : null);
  if (resolvedSessionDir && fs.existsSync(resolvedSessionDir)) {
    try {
      fs.rmdirSync(resolvedSessionDir);
    } catch {
      // Ignore non-empty or missing directories.
    }
  }
}
