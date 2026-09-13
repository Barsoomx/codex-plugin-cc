import fs from "node:fs";
import process from "node:process";

import { claimQueuedJob, readJobFile, resolveJobFile, resolveJobLogFile, upsertJob } from "./state.mjs";

export const SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";

export function nowIso() {
  return new Date().toISOString();
}

function normalizeProgressEvent(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return {
      message: String(value.message ?? "").trim(),
      phase: typeof value.phase === "string" && value.phase.trim() ? value.phase.trim() : null,
      threadId: typeof value.threadId === "string" && value.threadId.trim() ? value.threadId.trim() : null,
      turnId: typeof value.turnId === "string" && value.turnId.trim() ? value.turnId.trim() : null,
      runtime: value.runtime && typeof value.runtime === "object" && !Array.isArray(value.runtime) ? value.runtime : null,
      stderrMessage: value.stderrMessage == null ? null : String(value.stderrMessage).trim(),
      logTitle: typeof value.logTitle === "string" && value.logTitle.trim() ? value.logTitle.trim() : null,
      logBody: value.logBody == null ? null : String(value.logBody).trimEnd()
    };
  }

  return {
    message: String(value ?? "").trim(),
    phase: null,
    threadId: null,
    turnId: null,
    runtime: null,
    stderrMessage: String(value ?? "").trim(),
    logTitle: null,
    logBody: null
  };
}

export function appendLogLine(logFile, message) {
  const normalized = String(message ?? "").trim();
  if (!logFile || !normalized) {
    return;
  }
  fs.appendFileSync(logFile, `[${nowIso()}] ${normalized}\n`, "utf8");
}

export function appendLogBlock(logFile, title, body) {
  if (!logFile || !body) {
    return;
  }
  fs.appendFileSync(logFile, `\n[${nowIso()}] ${title}\n${String(body).trimEnd()}\n`, "utf8");
}

export function createJobLogFile(workspaceRoot, jobId, title) {
  const logFile = resolveJobLogFile(workspaceRoot, jobId);
  fs.writeFileSync(logFile, "", "utf8");
  if (title) {
    appendLogLine(logFile, `Starting ${title}.`);
  }
  return logFile;
}

export function createJobRecord(base, options = {}) {
  const env = options.env ?? process.env;
  const sessionId = env[options.sessionIdEnv ?? SESSION_ID_ENV];
  return {
    ...base,
    createdAt: nowIso(),
    ...(sessionId ? { sessionId } : {})
  };
}

export function createJobProgressUpdater(workspaceRoot, jobId) {
  let lastPhase = null;
  let lastThreadId = null;
  let lastTurnId = null;

  return (event) => {
    const normalized = normalizeProgressEvent(event);
    const patch = { id: jobId };
    let changed = false;

    if (normalized.phase && normalized.phase !== lastPhase) {
      lastPhase = normalized.phase;
      patch.phase = normalized.phase;
      changed = true;
    }

    if (normalized.threadId && normalized.threadId !== lastThreadId) {
      lastThreadId = normalized.threadId;
      patch.threadId = normalized.threadId;
      changed = true;
    }

    if (normalized.turnId && normalized.turnId !== lastTurnId) {
      lastTurnId = normalized.turnId;
      patch.turnId = normalized.turnId;
      changed = true;
    }

    if (normalized.runtime) {
      patch.runtime = normalized.runtime;
      changed = true;
    }

    if (!changed) {
      return;
    }

    upsertJob(workspaceRoot, patch);
  };
}

export function createProgressReporter({ stderr = false, logFile = null, onEvent = null } = {}) {
  if (!stderr && !logFile && !onEvent) {
    return null;
  }

  return (eventOrMessage) => {
    const event = normalizeProgressEvent(eventOrMessage);
    const stderrMessage = event.stderrMessage ?? event.message;
    if (stderr && stderrMessage) {
      process.stderr.write(`[codex] ${stderrMessage}\n`);
    }
    appendLogLine(logFile, event.message);
    appendLogBlock(logFile, event.logTitle, event.logBody);
    onEvent?.(event);
  };
}

function readStoredJobOrNull(workspaceRoot, jobId) {
  const jobFile = resolveJobFile(workspaceRoot, jobId);
  if (!fs.existsSync(jobFile)) {
    return null;
  }
  return readJobFile(jobFile);
}

export async function runTrackedJob(job, runner, options = {}) {
  const claimed = claimQueuedJob(job.workspaceRoot, job.id, process.pid);
  if (!claimed) {
    return null;
  }

  const requestedSettings = claimed.request?.settings;
  const requestedRuntime =
    requestedSettings && typeof requestedSettings === "object"
      ? {
          source: "requested",
          model: null,
          reasoningEffort: null,
          contextWindow: null,
          configuredModel: requestedSettings.model ?? null,
          configuredReasoningEffort: requestedSettings.effort ?? null,
          configuredContextWindow: requestedSettings.contextWindow ?? null
        }
      : null;
  const runningRecord = {
    ...claimed,
    logFile: options.logFile ?? claimed.logFile ?? null,
    ...(claimed.runtime ? { runtime: claimed.runtime } : requestedRuntime ? { runtime: requestedRuntime } : {})
  };
  upsertJob(job.workspaceRoot, runningRecord);

  try {
    const execution = await runner();
    const completionStatus = execution.exitStatus === 0 ? "completed" : "failed";
    const completedAt = nowIso();
    const existing = readStoredJobOrNull(job.workspaceRoot, job.id) ?? runningRecord;
    const status = existing.status === "cancelled" ? "cancelled" : completionStatus;
    const payloadError = execution.payload?.error;
    const errorMessage =
      status === "failed"
        ? typeof payloadError === "string"
          ? payloadError
          : payloadError?.message ??
            (payloadError && typeof payloadError === "object" ? JSON.stringify(payloadError) : null) ??
            execution.errorMessage ??
            execution.error?.message ??
            (typeof execution.rendered === "string" && execution.rendered.trim() ? execution.rendered.trim() : null) ??
            null
        : existing.errorMessage ?? null;
    const terminalPatch = {
      id: job.id,
      status,
      phase: status === "completed" ? "done" : status === "cancelled" ? "cancelled" : "failed",
      pid: null,
      completedAt,
      result: execution.payload,
      rendered: execution.rendered,
      ...(execution.threadId ? { threadId: execution.threadId } : {}),
      ...(execution.turnId ? { turnId: execution.turnId } : {}),
      ...(execution.summary ? { summary: execution.summary } : {}),
      ...(errorMessage ? { errorMessage } : {}),
      ...(execution.payload?.runtime ? { runtime: execution.payload.runtime } : {})
    };
    upsertJob(job.workspaceRoot, terminalPatch);
    appendLogBlock(options.logFile ?? job.logFile ?? null, "Final output", execution.rendered);
    return execution;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const existing = readStoredJobOrNull(job.workspaceRoot, job.id) ?? runningRecord;
    const completedAt = nowIso();
    const status = existing.status === "cancelled" ? "cancelled" : "failed";
    const terminalErrorMessage = status === "cancelled" ? existing.errorMessage ?? "Cancelled by user." : errorMessage;
    upsertJob(job.workspaceRoot, {
      id: job.id,
      status,
      phase: status === "cancelled" ? "cancelled" : "failed",
      pid: null,
      errorMessage: terminalErrorMessage,
      completedAt,
      logFile: options.logFile ?? job.logFile ?? existing.logFile ?? null
    });
    throw error;
  }
}
