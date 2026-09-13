import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  BROKER_ENDPOINT_ENV,
  BROKER_OPT_IN_ENV,
  CLOSE_TIMEOUT_ENV,
  CodexAppServerClient,
  INITIALIZE_TIMEOUT_ENV,
  REQUEST_TIMEOUT_CODE,
  REQUEST_TIMEOUT_ENV
} from "../plugins/codex/scripts/lib/app-server.mjs";
import { createBrokerEndpoint, parseBrokerEndpoint } from "../plugins/codex/scripts/lib/broker-endpoint.mjs";
import {
  clearBrokerSessionIfOwned,
  cleanupOwnedBrokerSession,
  ensureBrokerSession,
  loadBrokerSession,
  saveBrokerSession,
  sendBrokerShutdown,
  waitForBrokerEndpoint
} from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import {
  CODEX_BINARY_ENV,
  codexBinaryRequiresShell,
  resolveCodexBinary,
  terminateProcessTree
} from "../plugins/codex/scripts/lib/process.mjs";

const BROKER_SCRIPT = fileURLToPath(new URL("../plugins/codex/scripts/app-server-broker.mjs", import.meta.url));

function makeTempDir(t, prefix = "cxc-lifecycle-") {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  return tempDir;
}

function installFakeCodex(t) {
  const binDir = makeTempDir(t, "cxc-fake-codex-");
  const scriptPath = path.join(binDir, "fake-codex.mjs");
  const source = `#!/usr/bin/env node
import fs from "node:fs";
import process from "node:process";
import readline from "node:readline";

const behavior = process.env.CXC_FAKE_BEHAVIOR || "normal";
if (process.env.CXC_FAKE_PID_FILE) {
  fs.writeFileSync(process.env.CXC_FAKE_PID_FILE, String(process.pid));
}
if (process.env.CXC_FAKE_START_FILE) {
  fs.appendFileSync(process.env.CXC_FAKE_START_FILE, String(process.pid) + "\\n");
}
if (process.argv[2] !== "app-server") {
  process.exit(2);
}
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    if (behavior !== "stall-initialize") {
      send({ id: message.id, result: { userAgent: "lifecycle-test" } });
    }
    return;
  }
  if (message.method === "initialized") return;
  if (message.method === "config/read") {
    if (behavior === "disconnect-request") process.exit(7);
    if (behavior !== "stall-request") send({ id: message.id, result: {} });
    return;
  }
  if (message.method === "turn/start") {
    const threadId = message.params.threadId;
    const turnId = "turn-lifecycle";
    send({ id: message.id, result: { turn: { id: turnId, status: "inProgress" } } });
    if (behavior !== "hang-turn") {
      setTimeout(() => {
        send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } });
      }, 350);
    }
    return;
  }
  send({ id: message.id, result: {} });
});
`;
  fs.writeFileSync(scriptPath, source, { encoding: "utf8", mode: 0o755 });
  fs.chmodSync(scriptPath, 0o755);

  if (process.platform !== "win32") {
    const command = path.join(binDir, "codex");
    fs.copyFileSync(scriptPath, command);
    fs.chmodSync(command, 0o755);
    return command;
  }

  const command = path.join(binDir, "codex.cmd");
  fs.writeFileSync(command, `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`, "utf8");
  return command;
}

function fakeEnv(command, behavior, overrides = {}) {
  return {
    ...process.env,
    [CODEX_BINARY_ENV]: command,
    [BROKER_ENDPOINT_ENV]: "",
    [BROKER_OPT_IN_ENV]: "0",
    [CLOSE_TIMEOUT_ENV]: "250",
    [INITIALIZE_TIMEOUT_ENV]: "100",
    [REQUEST_TIMEOUT_ENV]: "100",
    CXC_FAKE_BEHAVIOR: behavior,
    ...overrides
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  let timer;
  return await Promise.race([
    once(child, "exit").then(([code, signal]) => ({ code, signal })),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    })
  ]).finally(() => clearTimeout(timer));
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

async function waitUntil(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await delay(25);
  }
  return predicate();
}

function makeJsonPeer(socket) {
  let buffer = "";
  const messages = [];
  const waiters = [];

  function dispatch(message) {
    const index = waiters.findIndex((waiter) => waiter.predicate(message));
    if (index === -1) {
      messages.push(message);
      return;
    }
    const [waiter] = waiters.splice(index, 1);
    clearTimeout(waiter.timer);
    waiter.resolve(message);
  }

  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buffer += chunk;
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (line.trim()) dispatch(JSON.parse(line));
      newlineIndex = buffer.indexOf("\n");
    }
  });

  return {
    send(message) {
      socket.write(`${JSON.stringify(message)}\n`);
    },
    next(predicate, timeoutMs = 1_000) {
      const index = messages.findIndex(predicate);
      if (index !== -1) {
        return Promise.resolve(messages.splice(index, 1)[0]);
      }
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, timer: null };
        waiter.timer = setTimeout(() => {
          const waiterIndex = waiters.indexOf(waiter);
          if (waiterIndex !== -1) waiters.splice(waiterIndex, 1);
          reject(new Error("Timed out waiting for broker JSONL response."));
        }, timeoutMs);
        waiters.push(waiter);
      });
    }
  };
}

test("resolveCodexBinary honors explicit override and PATH fixtures", (t) => {
  assert.equal(resolveCodexBinary({ [CODEX_BINARY_ENV]: "/opt/codex-custom", PATH: "" }), "/opt/codex-custom");

  const binDir = makeTempDir(t, "cxc-path-codex-");
  const binaryName = process.platform === "win32" ? "codex.cmd" : "codex";
  const pathBinary = path.join(binDir, binaryName);
  fs.writeFileSync(pathBinary, "fixture", { mode: 0o755 });
  fs.chmodSync(pathBinary, 0o755);
  assert.equal(resolveCodexBinary({ PATH: binDir }), pathBinary);
  if (process.platform === "win32") {
    const laterBinDir = makeTempDir(t, "cxc-later-codex-");
    fs.writeFileSync(path.join(laterBinDir, "codex.exe"), "unrelated");
    assert.equal(resolveCodexBinary({ PATH: `${binDir}${path.delimiter}${laterBinDir}` }), pathBinary);
  }
  assert.equal(codexBinaryRequiresShell("C:\\tools\\codex.exe", "win32"), false);
  assert.equal(codexBinaryRequiresShell("C:\\tools\\codex.cmd", "win32"), true);
});

test("resolveCodexBinary prefers native ~/.local/bin/codex for a WSL environment", (t) => {
  const homeDir = makeTempDir(t, "cxc-wsl-home-");
  const nativeBinary = path.join(homeDir, ".local", "bin", "codex");
  fs.mkdirSync(path.dirname(nativeBinary), { recursive: true });
  fs.writeFileSync(nativeBinary, "native", { mode: 0o755 });
  fs.chmodSync(nativeBinary, 0o755);

  assert.equal(resolveCodexBinary({
    HOME: homeDir,
    PATH: "/mnt/c/Users/test/AppData/Roaming/npm",
    WSL_DISTRO_NAME: "Ubuntu-24.04"
  }), nativeBinary);
});

test("direct app-server initialization and ordinary RPC acknowledgements time out", async (t) => {
  const cwd = makeTempDir(t);
  const command = installFakeCodex(t);

  await assert.rejects(
    CodexAppServerClient.connect(cwd, {
      env: fakeEnv(command, "stall-initialize")
    }),
    (error) => error?.code === REQUEST_TIMEOUT_CODE && error?.transport === "direct"
  );

  const client = await CodexAppServerClient.connect(cwd, {
    env: fakeEnv(command, "stall-request")
  });
  assert.equal(client.transport, "direct");
  try {
    await assert.rejects(
      client.request("config/read", { includeLayers: false, cwd }),
      (error) => error?.code === REQUEST_TIMEOUT_CODE && error?.transport === "direct"
    );
  } finally {
    await client.close();
  }
});

test("a direct app-server disconnect rejects the in-flight request", async (t) => {
  const cwd = makeTempDir(t);
  const command = installFakeCodex(t);
  const client = await CodexAppServerClient.connect(cwd, {
    disableBroker: true,
    env: fakeEnv(command, "disconnect-request")
  });
  try {
    await assert.rejects(
      client.request("config/read", { includeLayers: false, cwd }),
      /exited unexpectedly|connection closed/i
    );
  } finally {
    await client.close();
  }
});

test("client records only acknowledged state-changing requests", async (t) => {
  const cwd = makeTempDir(t);
  const command = installFakeCodex(t);
  const client = await CodexAppServerClient.connect(cwd, {
    env: fakeEnv(command, "normal")
  });
  try {
    assert.equal(client.hasAcceptedMutation, false);
    await client.request("config/read", { includeLayers: false, cwd });
    assert.equal(client.hasAcceptedMutation, false);
    await client.request("thread/name/set", { threadId: "thread-lifecycle", name: "Lifecycle" });
    assert.equal(client.hasAcceptedMutation, true);
  } finally {
    await client.close();
  }
});

test("broker initialization timeout is bounded and marked safe for pre-request fallback", async (t) => {
  const socketDir = makeTempDir(t, "cxc-wedged-broker-");
  const endpoint = createBrokerEndpoint(socketDir);
  const target = parseBrokerEndpoint(endpoint);
  const sockets = new Set();
  const server = net.createServer((socket) => sockets.add(socket));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(target.path, resolve);
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });

  await assert.rejects(
    CodexAppServerClient.connect(socketDir, {
      brokerEndpoint: endpoint,
      env: {
        ...process.env,
        [CLOSE_TIMEOUT_ENV]: "100",
        [INITIALIZE_TIMEOUT_ENV]: "100"
      }
    }),
    (error) => error?.code === REQUEST_TIMEOUT_CODE && error?.transport === "broker" && error?.brokerFatal === true
  );
});

test("broker readiness and shutdown probes cannot wait indefinitely", async () => {
  class StalledSocket extends EventEmitter {
    destroy() {
      this.destroyed = true;
    }
    end() {}
    setEncoding() {}
    write() {}
  }

  const readinessSocket = new StalledSocket();
  const ready = await waitForBrokerEndpoint("unix:/unused", 60, {
    connect: () => readinessSocket
  });
  assert.equal(ready, false);
  assert.equal(readinessSocket.destroyed, true);

  const shutdownSocket = new StalledSocket();
  const acknowledged = await sendBrokerShutdown("unix:/unused", 60, {
    connect: () => shutdownSocket
  });
  assert.equal(acknowledged, false);
  assert.equal(shutdownSocket.destroyed, true);
});

test("broker shuts down its owned child when the streaming owner disconnects", async (t) => {
  const cwd = makeTempDir(t);
  const socketDir = makeTempDir(t, "cxc-idle-broker-");
  const childPidFile = path.join(cwd, "fake-codex.pid");
  const command = installFakeCodex(t);
  const endpoint = createBrokerEndpoint(socketDir);
  const target = parseBrokerEndpoint(endpoint);
  const pidFile = path.join(socketDir, "broker.pid");
  let stderr = "";
  const broker = spawn(process.execPath, [
    BROKER_SCRIPT,
    "serve",
    "--endpoint",
    endpoint,
    "--cwd",
    cwd,
    "--pid-file",
    pidFile,
    "--idle-timeout-ms",
    "100"
  ], {
    cwd,
    detached: true,
    env: fakeEnv(command, "hang-turn", {
      CODEX_COMPANION_BROKER_SHUTDOWN_TIMEOUT_MS: "250",
      CXC_FAKE_PID_FILE: childPidFile
    }),
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true
  });
  broker.stderr.setEncoding("utf8");
  broker.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  t.after(async () => {
    if (broker.exitCode === null && broker.signalCode === null) {
      terminateProcessTree(broker.pid);
      await waitForChildExit(broker, 1_000);
    }
  });

  assert.equal(await waitForBrokerEndpoint(endpoint, 2_000), true, stderr);
  assert.equal(await waitUntil(() => fs.existsSync(childPidFile), 1_000), true, stderr);
  const childPid = Number.parseInt(fs.readFileSync(childPidFile, "utf8"), 10);
  assert.equal(processIsAlive(childPid), true);
  const socket = net.createConnection({ path: target.path });
  await once(socket, "connect");
  const peer = makeJsonPeer(socket);
  peer.send({ id: 1, method: "initialize", params: {} });
  await peer.next((message) => message.id === 1);
  peer.send({ id: 2, method: "turn/start", params: { threadId: "thread-lifecycle" } });
  await peer.next((message) => message.id === 2);
  const closed = once(socket, "close");
  socket.end();
  await closed;

  const exit = await waitForChildExit(broker, 1_500);
  assert.deepEqual(exit, { code: 1, signal: null }, stderr);
  assert.equal(await waitUntil(() => !processIsAlive(childPid), 1_000), true, "owned Codex child survived broker shutdown");
  assert.equal(fs.existsSync(pidFile), false);
  if (target.kind === "unix") {
    assert.equal(fs.existsSync(target.path), false);
  }
});

test("idle broker removes its matching registry and owned cxc artifacts", async (t) => {
  const cwd = makeTempDir(t);
  const pluginDataDir = makeTempDir(t, "cxc-plugin-data-");
  const command = installFakeCodex(t);
  const startFile = path.join(cwd, "fake-codex-starts");
  const previousPluginData = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
  t.after(() => {
    if (previousPluginData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previousPluginData;
  });

  const env = fakeEnv(command, "normal", {
    CLAUDE_PLUGIN_DATA: pluginDataDir,
    CODEX_COMPANION_BROKER_IDLE_TIMEOUT_MS: "150",
    CODEX_COMPANION_BROKER_SHUTDOWN_TIMEOUT_MS: "250",
    CODEX_COMPANION_SESSION_ID: "session-lifecycle",
    CXC_FAKE_START_FILE: startFile
  });
  const [session, concurrentSession] = await Promise.all([
    ensureBrokerSession(cwd, { env, timeoutMs: 2_000 }),
    ensureBrokerSession(cwd, { env, timeoutMs: 2_000 })
  ]);
  assert.ok(session);
  assert.equal(concurrentSession?.endpoint, session.endpoint);
  assert.equal(concurrentSession?.pid, session.pid);
  assert.equal(fs.readFileSync(startFile, "utf8").trim().split(/\r?\n/).length, 1);
  assert.equal(session.sessionId, "session-lifecycle");
  assert.equal(loadBrokerSession(cwd)?.endpoint, session.endpoint);
  t.after(() => {
    if (processIsAlive(session.pid)) terminateProcessTree(session.pid);
  });

  assert.equal(await waitUntil(() => !processIsAlive(session.pid), 2_000), true, "idle broker did not exit");
  assert.equal(loadBrokerSession(cwd), null);
  assert.equal(fs.existsSync(session.pidFile), false);
  assert.equal(fs.existsSync(session.logFile), false);
  assert.equal(fs.existsSync(session.sessionDir), false);
});

test("owned cleanup removes old artifacts while preserving a replacement broker", async (t) => {
  const cwd = makeTempDir(t);
  const pluginDataDir = makeTempDir(t, "cxc-replacement-state-");
  const previousPluginData = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
  t.after(() => {
    if (previousPluginData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previousPluginData;
  });

  const ownDir = makeTempDir(t, "cxc-owned-old-");
  const own = {
    endpoint: createBrokerEndpoint(ownDir),
    pid: process.pid,
    pidFile: path.join(ownDir, "broker.pid"),
    logFile: path.join(ownDir, "broker.log"),
    sessionDir: ownDir
  };
  fs.writeFileSync(own.pidFile, String(own.pid));
  fs.writeFileSync(own.logFile, "old broker log");

  const replacementDir = makeTempDir(t, "cxc-owned-new-");
  const replacement = {
    endpoint: createBrokerEndpoint(replacementDir),
    pid: process.pid + 1,
    pidFile: path.join(replacementDir, "broker.pid"),
    logFile: path.join(replacementDir, "broker.log"),
    sessionDir: replacementDir,
    sessionId: "replacement"
  };
  fs.writeFileSync(replacement.pidFile, String(replacement.pid));
  fs.writeFileSync(replacement.logFile, "replacement broker log");
  saveBrokerSession(cwd, replacement);

  assert.equal(await clearBrokerSessionIfOwned(cwd, own), false);
  assert.deepEqual(await cleanupOwnedBrokerSession(cwd, own), {
    cleaned: true,
    registryCleared: false
  });
  assert.equal(loadBrokerSession(cwd)?.endpoint, replacement.endpoint);
  assert.equal(fs.existsSync(own.pidFile), false);
  assert.equal(fs.existsSync(own.logFile), false);
  assert.equal(fs.existsSync(own.sessionDir), false);
  assert.equal(fs.existsSync(replacement.logFile), true);
});
