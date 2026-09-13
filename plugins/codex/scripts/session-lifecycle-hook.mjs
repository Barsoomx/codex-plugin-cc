#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { terminateProcessTree } from "./lib/process.mjs";
import { BROKER_ENDPOINT_ENV } from "./lib/app-server.mjs";
import {
  clearBrokerSessionIfOwned,
  LOG_FILE_ENV,
  loadBrokerSession,
  PID_FILE_ENV,
  sendBrokerShutdown,
  teardownBrokerSession
} from "./lib/broker-lifecycle.mjs";
import { listJobs, resolveStateFile, upsertJob } from "./lib/state.mjs";
import { TRANSCRIPT_PATH_ENV } from "./lib/claude-session-transfer.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import { readProcessIdentity } from "./lib/worker-identity.mjs";

export const SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";

function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function appendEnvVar(name, value) {
  if (!process.env.CLAUDE_ENV_FILE || value == null || value === "") {
    return;
  }
  fs.appendFileSync(process.env.CLAUDE_ENV_FILE, `export ${name}=${shellEscape(value)}\n`, "utf8");
}

function cleanupSessionJobs(cwd, sessionId) {
  if (!cwd || !sessionId) {
    return;
  }

  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const stateFile = resolveStateFile(workspaceRoot);
  if (!fs.existsSync(stateFile)) {
    return;
  }

  const removedJobs = listJobs(workspaceRoot).filter((job) => job.sessionId === sessionId);
  if (removedJobs.length === 0) {
    return;
  }

  for (const job of removedJobs) {
    const stillRunning = job.status === "queued" || job.status === "running";
    if (!stillRunning || job.detached) {
      continue;
    }
    try {
      const identity = readProcessIdentity(job.pid);
      if (job.workerIdentity && identity && identity.bootId === job.workerIdentity.bootId && identity.startTime === job.workerIdentity.startTime) {
        terminateProcessTree(job.pid);
      }
    } catch {
      // Ignore teardown failures during session shutdown.
    }
    const stopped = { ...job, status: "cancelled", phase: "cancelled", pid: null, completedAt: new Date().toISOString(), errorMessage: "Claude session ended before foreground work completed." };
    upsertJob(workspaceRoot, stopped);
  }
}

function handleSessionStart(input) {
  appendEnvVar(SESSION_ID_ENV, input.session_id);
  appendEnvVar(TRANSCRIPT_PATH_ENV, input.transcript_path);
  appendEnvVar(PLUGIN_DATA_ENV, process.env[PLUGIN_DATA_ENV]);
  appendEnvVar("CODEX_COMPANION_ROOT", fileURLToPath(new URL("..", import.meta.url)));
}

async function handleSessionEnd(input) {
  const cwd = input.cwd || process.cwd();
  const sessionId = input.session_id || process.env[SESSION_ID_ENV];
  cleanupSessionJobs(cwd, sessionId);
  // Detached workers outlive the caller and may still be using an opt-in broker.
  if (listJobs(resolveWorkspaceRoot(cwd)).some(job => job.detached && (job.status === "queued" || job.status === "running"))) return;
  const brokerSession =
    loadBrokerSession(cwd) ??
    (process.env[BROKER_ENDPOINT_ENV]
      ? {
          endpoint: process.env[BROKER_ENDPOINT_ENV],
          pidFile: process.env[PID_FILE_ENV] ?? null,
          logFile: process.env[LOG_FILE_ENV] ?? null
        }
      : null);
  const brokerEndpoint = brokerSession?.endpoint ?? null;
  const pidFile = brokerSession?.pidFile ?? null;
  const logFile = brokerSession?.logFile ?? null;
  const sessionDir = brokerSession?.sessionDir ?? null;
  const pid = brokerSession?.pid ?? null;
  const ownsBroker = brokerSession?.sessionId === sessionId && Boolean(sessionId);
  const explicitEndpoint = brokerEndpoint && process.env[BROKER_ENDPOINT_ENV] === brokerEndpoint;
  // A registry entry alone does not prove ownership of a broker from another
  // live Claude session, particularly one left by the previous plugin version.
  if (!ownsBroker && !explicitEndpoint) return;

  let acknowledged = false;
  if (brokerEndpoint) {
    acknowledged = await sendBrokerShutdown(brokerEndpoint);
  }
  if (!acknowledged) return;

  teardownBrokerSession({
    endpoint: brokerEndpoint,
    pidFile,
    logFile,
    sessionDir,
    pid,
    // The acknowledged broker shuts down its own ChildProcess handles. A PID
    // loaded from a file is not sufficient evidence for a separate kill here.
    killProcess: null
  });
  await clearBrokerSessionIfOwned(cwd, brokerSession);
}

async function main() {
  const input = readHookInput();
  const eventName = process.argv[2] ?? input.hook_event_name ?? "";

  if (eventName === "SessionStart") {
    handleSessionStart(input);
    return;
  }

  if (eventName === "SessionEnd") {
    await handleSessionEnd(input);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
