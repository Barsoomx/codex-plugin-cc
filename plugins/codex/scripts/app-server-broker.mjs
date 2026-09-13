#!/usr/bin/env node

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";

import { parseArgs } from "./lib/args.mjs";
import { BROKER_BUSY_RPC_CODE, CodexAppServerClient } from "./lib/app-server.mjs";
import { parseBrokerEndpoint } from "./lib/broker-endpoint.mjs";
import { cleanupOwnedBrokerSession } from "./lib/broker-lifecycle.mjs";

const STREAMING_METHODS = new Set(["turn/start", "review/start", "thread/compact/start"]);
const BROKER_IDLE_TIMEOUT_ENV = "CODEX_COMPANION_BROKER_IDLE_TIMEOUT_MS";
const BROKER_SHUTDOWN_TIMEOUT_ENV = "CODEX_COMPANION_BROKER_SHUTDOWN_TIMEOUT_MS";
const DEFAULT_BROKER_IDLE_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_BROKER_SHUTDOWN_TIMEOUT_MS = 5_000;

function resolveTimeoutMs(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function buildStreamThreadIds(method, params, result) {
  const threadIds = new Set();
  if (params?.threadId) {
    threadIds.add(params.threadId);
  }
  if (method === "review/start" && result?.reviewThreadId) {
    threadIds.add(result.reviewThreadId);
  }
  return threadIds;
}

function buildJsonRpcError(code, message, data) {
  return data === undefined ? { code, message } : { code, message, data };
}

function send(socket, message) {
  if (socket.destroyed) {
    return;
  }
  socket.write(`${JSON.stringify(message)}\n`);
}

function isInterruptRequest(message) {
  return message?.method === "turn/interrupt";
}

function writePidFile(pidFile) {
  if (!pidFile) {
    return;
  }
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  fs.writeFileSync(pidFile, `${process.pid}\n`, "utf8");
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (subcommand !== "serve") {
    throw new Error("Usage: node scripts/app-server-broker.mjs serve --endpoint <value> [--cwd <path>] [--pid-file <path>] [--log-file <path>]");
  }

  const { options } = parseArgs(argv, {
    valueOptions: ["cwd", "pid-file", "log-file", "endpoint", "idle-timeout-ms"]
  });

  if (!options.endpoint) {
    throw new Error("Missing required --endpoint.");
  }

  const cwd = options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
  const endpoint = String(options.endpoint);
  const listenTarget = parseBrokerEndpoint(endpoint);
  const pidFile = options["pid-file"] ? path.resolve(options["pid-file"]) : null;
  const logFile = options["log-file"]
    ? path.resolve(options["log-file"])
    : (pidFile ? path.join(path.dirname(pidFile), "broker.log") : null);
  const idleTimeoutMs = resolveTimeoutMs(
    options["idle-timeout-ms"] ?? process.env[BROKER_IDLE_TIMEOUT_ENV],
    DEFAULT_BROKER_IDLE_TIMEOUT_MS
  );
  const shutdownTimeoutMs = resolveTimeoutMs(
    process.env[BROKER_SHUTDOWN_TIMEOUT_ENV],
    DEFAULT_BROKER_SHUTDOWN_TIMEOUT_MS
  );

  const appClient = await CodexAppServerClient.connect(cwd, { disableBroker: true });
  let activeRequestSocket = null;
  let activeStreamSocket = null;
  let activeStreamThreadIds = null;
  let pendingRequestCount = 0;
  const sockets = new Set();
  let idleTimer = null;
  let shutdownPromise = null;

  function cancelIdleShutdown() {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  function routeNotification(message) {
    const target = activeRequestSocket ?? activeStreamSocket;
    if (target) {
      send(target, message);
    }
    if (message.method === "turn/completed" && activeStreamSocket) {
      const threadId = message.params?.threadId ?? null;
      if (!threadId || !activeStreamThreadIds || activeStreamThreadIds.has(threadId)) {
        activeStreamSocket = null;
        activeStreamThreadIds = null;
        scheduleIdleShutdown(server);
      }
    }
  }

  function waitForServerClose(server) {
    let timer;
    const closed = new Promise((resolve) => {
      if (!server.listening) {
        resolve();
        return;
      }
      server.close(resolve);
    });
    return Promise.race([
      closed,
      new Promise((resolve) => {
        timer = setTimeout(resolve, shutdownTimeoutMs);
      })
    ]).finally(() => clearTimeout(timer));
  }

  function shutdown(server) {
    if (shutdownPromise) {
      return shutdownPromise;
    }
    cancelIdleShutdown();
    shutdownPromise = (async () => {
      const serverClosed = waitForServerClose(server);
      for (const socket of sockets) {
        socket.end();
      }
      const forceSocketTimer = setTimeout(() => {
        for (const socket of sockets) {
          socket.destroy();
        }
      }, Math.min(250, shutdownTimeoutMs));
      await Promise.all([
        appClient.close().catch(() => {}),
        serverClosed
      ]).finally(() => {
        clearTimeout(forceSocketTimer);
        for (const socket of sockets) {
          socket.destroy();
        }
      });
      await cleanupOwnedBrokerSession(cwd, {
        endpoint,
        pidFile,
        logFile,
        sessionDir: pidFile ? path.dirname(pidFile) : null,
        pid: process.pid
      });
    })();
    return shutdownPromise;
  }

  function scheduleIdleShutdown(server) {
    cancelIdleShutdown();
    if (shutdownPromise || sockets.size > 0 || pendingRequestCount > 0 || activeRequestSocket || activeStreamSocket) {
      return;
    }

    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (sockets.size > 0 || pendingRequestCount > 0 || activeRequestSocket || activeStreamSocket) {
        return;
      }
      shutdown(server).finally(() => process.exit(0));
    }, idleTimeoutMs);
  }

  appClient.setNotificationHandler(routeNotification);

  const server = net.createServer((socket) => {
    if (shutdownPromise) {
      socket.on("error", () => {});
      socket.destroy();
      return;
    }
    cancelIdleShutdown();
    sockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";

    socket.on("data", async (chunk) => {
      buffer += chunk;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");

        if (!line.trim()) {
          continue;
        }

        let message;
        try {
          message = JSON.parse(line);
        } catch (error) {
          send(socket, {
            id: null,
            error: buildJsonRpcError(-32700, `Invalid JSON: ${error.message}`)
          });
          continue;
        }

        if (message.id !== undefined && message.method === "initialize") {
          send(socket, {
            id: message.id,
            result: {
              userAgent: "codex-companion-broker"
            }
          });
          continue;
        }

        if (message.method === "initialized" && message.id === undefined) {
          continue;
        }

        if (message.id !== undefined && message.method === "broker/shutdown") {
          send(socket, { id: message.id, result: {} });
          await shutdown(server);
          process.exit(0);
          return;
        }

        if (message.id === undefined) {
          continue;
        }

        const allowInterruptDuringActiveStream =
          isInterruptRequest(message) && activeStreamSocket && activeStreamSocket !== socket && !activeRequestSocket;

        if (
          ((activeRequestSocket && activeRequestSocket !== socket) || (activeStreamSocket && activeStreamSocket !== socket)) &&
          !allowInterruptDuringActiveStream
        ) {
          send(socket, {
            id: message.id,
            error: buildJsonRpcError(BROKER_BUSY_RPC_CODE, "Shared Codex broker is busy.")
          });
          continue;
        }

        if (allowInterruptDuringActiveStream) {
          pendingRequestCount += 1;
          try {
            const result = await appClient.request(message.method, message.params ?? {});
            send(socket, { id: message.id, result });
          } catch (error) {
            send(socket, {
              id: message.id,
              error: buildJsonRpcError(error.rpcCode ?? -32000, error.message)
            });
          } finally {
            pendingRequestCount -= 1;
            scheduleIdleShutdown(server);
          }
          continue;
        }

        const isStreaming = STREAMING_METHODS.has(message.method);
        activeRequestSocket = socket;
        pendingRequestCount += 1;
        if (isStreaming) {
          activeStreamSocket = socket;
          activeStreamThreadIds = buildStreamThreadIds(message.method, message.params ?? {}, {});
        }

        try {
          const result = await appClient.request(message.method, message.params ?? {});
          send(socket, { id: message.id, result });
          if (isStreaming && activeStreamSocket === socket) {
            for (const threadId of buildStreamThreadIds(message.method, message.params ?? {}, result)) {
              activeStreamThreadIds.add(threadId);
            }
          }
        } catch (error) {
          send(socket, {
            id: message.id,
            error: buildJsonRpcError(error.rpcCode ?? -32000, error.message)
          });
          if (isStreaming && activeStreamSocket === socket) {
            activeStreamSocket = null;
            activeStreamThreadIds = null;
          }
        } finally {
          if (activeRequestSocket === socket) {
            activeRequestSocket = null;
          }
          pendingRequestCount -= 1;
          scheduleIdleShutdown(server);
        }
      }
    });

    function handleSocketLoss() {
      sockets.delete(socket);
      if (!shutdownPromise && activeStreamSocket === socket) {
        shutdown(server).finally(() => process.exit(1));
        return;
      }
      scheduleIdleShutdown(server);
    }

    socket.on("close", handleSocketLoss);
    socket.on("error", handleSocketLoss);
  });

  appClient.exitPromise.then(() => {
    if (!shutdownPromise) {
      shutdown(server).finally(() => process.exit(1));
    }
  });

  process.once("SIGTERM", async () => {
    await shutdown(server);
    process.exit(0);
  });

  process.once("SIGINT", async () => {
    await shutdown(server);
    process.exit(0);
  });

  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(listenTarget.path, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    await shutdown(server);
    throw error;
  }
  writePidFile(pidFile);
  server.on("error", (error) => {
    if (!shutdownPromise) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      shutdown(server).finally(() => process.exit(1));
    }
  });
  scheduleIdleShutdown(server);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
