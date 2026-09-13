/**
 * @typedef {import("./app-server-protocol").AppServerNotification} AppServerNotification
 * @typedef {import("./app-server-protocol").ReviewTarget} ReviewTarget
 * @typedef {import("./app-server-protocol").ThreadItem} ThreadItem
 * @typedef {import("./app-server-protocol").ThreadResumeParams} ThreadResumeParams
 * @typedef {import("./app-server-protocol").ThreadStartParams} ThreadStartParams
 * @typedef {import("./app-server-protocol").Turn} Turn
 * @typedef {import("./app-server-protocol").UserInput} UserInput
 * @typedef {import("./app-server-protocol").AppServerResponse<"turn/start"> | import("./app-server-protocol").AppServerResponse<"review/start">} CaptureStartResponse
 * @typedef {((update: string | { message: string, phase: string | null, threadId?: string | null, turnId?: string | null, stderrMessage?: string | null, logTitle?: string | null, logBody?: string | null }) => void)} ProgressReporter
 * @typedef {{
 *   threadId: string,
 *   rootThreadId: string,
 *   threadIds: Set<string>,
 *   threadTurnIds: Map<string, string>,
 *   threadLabels: Map<string, string>,
 *   turnId: string | null,
 *   bufferedNotifications: AppServerNotification[],
 *   completion: Promise<TurnCaptureState>,
 *   resolveCompletion: (state: TurnCaptureState) => void,
 *   rejectCompletion: (error: unknown) => void,
 *   finalTurn: Turn | null,
 *   completed: boolean,
 *   finalAnswerSeen: boolean,
 *   pendingCollaborations: Set<string>,
 *   activeSubagentTurns: Set<string>,
 *   completionTimer: ReturnType<typeof setTimeout> | null,
 *   turnTimeoutTimer: ReturnType<typeof setTimeout> | null,
 *   lastAgentMessage: string,
 *   reviewText: string,
 *   reasoningSummary: string[],
 *   tokenUsage: object | null,
 *   modelContextWindow: number | null,
 *   error: unknown,
 *   messages: Array<{ lifecycle: string, phase: string | null, text: string }>,
 *   fileChanges: ThreadItem[],
 *   commandExecutions: ThreadItem[],
 *   onProgress: ProgressReporter | null
 * }} TurnCaptureState
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { readJsonFile } from "./fs.mjs";
import {
  BROKER_BUSY_RPC_CODE,
  BROKER_ENDPOINT_ENV,
  BROKER_OPT_IN_ENV,
  CodexAppServerClient
} from "./app-server.mjs";
import { loadBrokerSession } from "./broker-lifecycle.mjs";
import { binaryAvailable, resolveCodexBinary } from "./process.mjs";
import { resolveRuntimeSettings } from "./runtime-settings.mjs";

const SERVICE_NAME = "claude_code_codex_plugin";
const TASK_THREAD_PREFIX = "Codex Companion Task";
const DEFAULT_CONTINUE_PROMPT =
  "Continue from the current thread state. Pick the next highest-value step and follow through until the task is resolved.";
const EXTERNAL_AGENT_IMPORT_COMPLETED = "externalAgentConfig/import/completed";
const EXTERNAL_AGENT_IMPORT_TIMEOUT_MS = 2 * 60 * 1000;
const REVIEW_ONLY_DEVELOPER_INSTRUCTIONS =
  "This is a strictly read-only evidence review. Inspect files and repository history only. Never modify files or repository state. Never run tests, linters, builds, type checks, or other verification commands. Do not delegate this review back to the Codex companion. Report only evidence-based findings.";
const TASK_DEVELOPER_INSTRUCTIONS =
  "Complete the authorized requested work and infer routine implementation details. Do not begin with generic brainstorming, skill-selection, planning, or approval preambles. If blocked, finish all independent work first, then report the specific blocker. Preserve the requested scope: read-only and diagnosis requests do not authorize edits; implementation requests should use bounded, relevant verification.";
const SINGLE_AGENT_DEVELOPER_INSTRUCTIONS =
  "Do not spawn or delegate to subagents. Complete this work in the current thread.";
const HEADLESS_DEVELOPER_INSTRUCTIONS =
  "The current checkout is the sole evidence root for this review. Inspect its supplied diff and files only; do not inspect the live source checkout, parent directories, sibling worktrees, or earlier review reports. Do not discover, load, or invoke repository or user skills for this run.";

function cleanCodexStderr(stderr) {
  return stderr
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line && !line.startsWith("WARNING: proceeding, even though we could not update PATH:"))
    .join("\n");
}

/** @returns {ThreadStartParams} */
function buildThreadParams(cwd, options = {}) {
  return {
    cwd,
    model: options.model ?? null,
    approvalPolicy: options.approvalPolicy ?? "never",
    sandbox: options.sandbox ?? "read-only",
    serviceName: SERVICE_NAME,
    ephemeral: options.ephemeral ?? true,
    config: options.config ?? null,
    developerInstructions: options.developerInstructions ?? null
  };
}

/** @returns {ThreadResumeParams} */
function buildResumeParams(threadId, cwd, options = {}) {
  return {
    threadId,
    cwd,
    model: options.model ?? null,
    approvalPolicy: options.approvalPolicy ?? "never",
    sandbox: options.sandbox ?? "read-only",
    config: options.config ?? null,
    developerInstructions: options.developerInstructions ?? null
  };
}

function buildRuntimeConfig(settings, options = {}) {
  const config = {
    review_model: settings.model,
    features: {
      multi_agent: settings.multiAgent
    },
    agents: {
      job_max_runtime_seconds: settings.agentTimeoutSeconds
    }
  };

  if (settings.contextWindow !== null) {
    config.model_context_window = settings.contextWindow;
  }
  if (settings.autoCompactTokenLimit !== null) {
    config.model_auto_compact_token_limit = settings.autoCompactTokenLimit;
  }
  if (settings.effort !== null) {
    config.model_reasoning_effort = settings.effort;
  }
  if (options.headless) {
    config.skills = { include_instructions: false };
  }

  return config;
}

function buildDeveloperInstructions(settings, options = {}) {
  const instructions = [];
  if (options.reviewOnly) {
    instructions.push(REVIEW_ONLY_DEVELOPER_INSTRUCTIONS);
  } else {
    instructions.push(TASK_DEVELOPER_INSTRUCTIONS);
  }
  if (!settings.multiAgent) {
    instructions.push(SINGLE_AGENT_DEVELOPER_INSTRUCTIONS);
  }
  if (options.headless) {
    instructions.push(HEADLESS_DEVELOPER_INSTRUCTIONS);
  }
  if (typeof options.developerInstructions === "string" && options.developerInstructions.trim()) {
    instructions.push(options.developerInstructions.trim());
  }
  return instructions.length > 0 ? instructions.join("\n\n") : null;
}

function buildRuntimeMetadata(threadResponse, settings, turnState) {
  const model = threadResponse?.model ?? threadResponse?.thread?.model ?? null;
  const reasoningEffort =
    threadResponse?.reasoningEffort ?? threadResponse?.thread?.reasoningEffort ?? null;

  return {
    model,
    reasoningEffort,
    contextWindow: turnState.modelContextWindow,
    configuredModel: settings.model,
    configuredReasoningEffort: settings.effort,
    configuredContextWindow: settings.contextWindow,
    configuredAutoCompactTokenLimit: settings.autoCompactTokenLimit,
    turnTimeoutMs: settings.turnTimeoutMs,
    agentTimeoutSeconds: settings.agentTimeoutSeconds,
    multiAgent: settings.multiAgent,
    headless: settings.headless,
    tokenUsage: turnState.tokenUsage
  };
}

/** @returns {UserInput[]} */
function buildTurnInput(prompt) {
  return [{ type: "text", text: prompt, text_elements: [] }];
}

function shorten(text, limit = 72) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function looksLikeVerificationCommand(command) {
  return /\b(test|tests|lint|build|typecheck|type-check|check|verify|validate|pytest|jest|vitest|cargo test|npm test|pnpm test|yarn test|go test|mvn test|gradle test|tsc|eslint|ruff)\b/i.test(
    command
  );
}

function buildTaskThreadName(prompt) {
  const excerpt = shorten(prompt, 56);
  return excerpt ? `${TASK_THREAD_PREFIX}: ${excerpt}` : TASK_THREAD_PREFIX;
}

function extractThreadId(message) {
  return message?.params?.threadId ?? null;
}

function extractTurnId(message) {
  if (message?.params?.turnId) {
    return message.params.turnId;
  }
  if (message?.params?.turn?.id) {
    return message.params.turn.id;
  }
  return null;
}

function collectTouchedFiles(fileChanges) {
  const paths = new Set();
  for (const fileChange of fileChanges) {
    for (const change of fileChange.changes ?? []) {
      if (change.path) {
        paths.add(change.path);
      }
    }
  }
  return [...paths];
}

function normalizeReasoningText(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

function extractReasoningSections(value) {
  if (!value) {
    return [];
  }

  if (typeof value === "string") {
    const normalized = normalizeReasoningText(value);
    return normalized ? [normalized] : [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((entry) => extractReasoningSections(entry));
  }

  if (typeof value === "object") {
    if (typeof value.text === "string") {
      return extractReasoningSections(value.text);
    }
    if ("summary" in value) {
      return extractReasoningSections(value.summary);
    }
    if ("content" in value) {
      return extractReasoningSections(value.content);
    }
    if ("parts" in value) {
      return extractReasoningSections(value.parts);
    }
  }

  return [];
}

function mergeReasoningSections(existingSections, nextSections) {
  const merged = [];
  for (const section of [...existingSections, ...nextSections]) {
    const normalized = normalizeReasoningText(section);
    if (!normalized || merged.includes(normalized)) {
      continue;
    }
    merged.push(normalized);
  }
  return merged;
}

/**
 * @param {ProgressReporter | null | undefined} onProgress
 * @param {string | null | undefined} message
 * @param {string | null | undefined} [phase]
 */
function emitProgress(onProgress, message, phase = null, extra = {}) {
  if (!onProgress || !message) {
    return;
  }
  if (!phase && Object.keys(extra).length === 0) {
    onProgress(message);
    return;
  }
  onProgress({ message, phase, ...extra });
}

function emitLogEvent(onProgress, options = {}) {
  if (!onProgress) {
    return;
  }

  onProgress({
    message: options.message ?? "",
    phase: options.phase ?? null,
    stderrMessage: options.stderrMessage ?? null,
    logTitle: options.logTitle ?? null,
    logBody: options.logBody ?? null
  });
}

function labelForThread(state, threadId) {
  if (!threadId || threadId === state.rootThreadId || threadId === state.threadId) {
    return null;
  }
  return state.threadLabels.get(threadId) ?? threadId;
}

function registerThread(state, threadId, options = {}) {
  if (!threadId) {
    return;
  }

  state.threadIds.add(threadId);
  const label =
    options.threadName ??
    options.name ??
    options.agentNickname ??
    options.agentRole ??
    state.threadLabels.get(threadId) ??
    null;
  if (label) {
    state.threadLabels.set(threadId, label);
  }
}

function describeStartedItem(state, item) {
  switch (item.type) {
    case "enteredReviewMode":
      return { message: `Reviewer started: ${item.review}`, phase: "reviewing" };
    case "commandExecution":
      return {
        message: `Running command: ${shorten(item.command, 96)}`,
        phase: looksLikeVerificationCommand(item.command) ? "verifying" : "running"
      };
    case "fileChange":
      return { message: `Applying ${item.changes.length} file change(s).`, phase: "editing" };
    case "mcpToolCall":
      return { message: `Calling ${item.server}/${item.tool}.`, phase: "investigating" };
    case "dynamicToolCall":
      return { message: `Running tool: ${item.tool}.`, phase: "investigating" };
    case "collabAgentToolCall": {
      const subagents = (item.receiverThreadIds ?? []).map((threadId) => labelForThread(state, threadId) ?? threadId);
      const summary =
        subagents.length > 0
          ? `Starting subagent ${subagents.join(", ")} via collaboration tool: ${item.tool}.`
          : `Starting collaboration tool: ${item.tool}.`;
      return { message: summary, phase: "investigating" };
    }
    case "webSearch":
      return { message: `Searching: ${shorten(item.query, 96)}`, phase: "investigating" };
    default:
      return null;
  }
}

function describeCompletedItem(state, item) {
  switch (item.type) {
    case "commandExecution": {
      const exitCode = item.exitCode ?? "?";
      const statusLabel = item.status === "completed" ? "completed" : item.status;
      return {
        message: `Command ${statusLabel}: ${shorten(item.command, 96)} (exit ${exitCode})`,
        phase: looksLikeVerificationCommand(item.command) ? "verifying" : "running"
      };
    }
    case "fileChange":
      return { message: `File changes ${item.status}.`, phase: "editing" };
    case "mcpToolCall":
      return { message: `Tool ${item.server}/${item.tool} ${item.status}.`, phase: "investigating" };
    case "dynamicToolCall":
      return { message: `Tool ${item.tool} ${item.status}.`, phase: "investigating" };
    case "collabAgentToolCall": {
      const subagents = (item.receiverThreadIds ?? []).map((threadId) => labelForThread(state, threadId) ?? threadId);
      const summary =
        subagents.length > 0
          ? `Subagent ${subagents.join(", ")} ${item.status}.`
          : `Collaboration tool ${item.tool} ${item.status}.`;
      return { message: summary, phase: "investigating" };
    }
    case "exitedReviewMode":
      return { message: "Reviewer finished.", phase: "finalizing" };
    default:
      return null;
  }
}

/** @returns {TurnCaptureState} */
function createTurnCaptureState(threadId, options = {}) {
  let resolveCompletion;
  let rejectCompletion;
  const completion = new Promise((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });

  return {
    threadId,
    rootThreadId: threadId,
    threadIds: new Set([threadId]),
    threadTurnIds: new Map(),
    threadLabels: new Map(),
    turnId: null,
    bufferedNotifications: [],
    completion,
    resolveCompletion,
    rejectCompletion,
    finalTurn: null,
    completed: false,
    finalAnswerSeen: false,
    pendingCollaborations: new Set(),
    activeSubagentTurns: new Set(),
    completionTimer: null,
    turnTimeoutTimer: null,
    lastAgentMessage: "",
    reviewText: "",
    reasoningSummary: [],
    tokenUsage: null,
    modelContextWindow: null,
    error: null,
    messages: [],
    fileChanges: [],
    commandExecutions: [],
    onProgress: options.onProgress ?? null
  };
}

function clearCompletionTimer(state) {
  if (state.completionTimer) {
    clearTimeout(state.completionTimer);
    state.completionTimer = null;
  }
}

function clearTurnTimeoutTimer(state) {
  if (state.turnTimeoutTimer) {
    clearTimeout(state.turnTimeoutTimer);
    state.turnTimeoutTimer = null;
  }
}

function clearCaptureTimers(state) {
  clearCompletionTimer(state);
  clearTurnTimeoutTimer(state);
}

function completeTurn(state, turn = null, options = {}) {
  if (state.completed) {
    return;
  }

  clearCaptureTimers(state);
  state.completed = true;

  if (turn) {
    state.finalTurn = turn;
    if (!state.turnId) {
      state.turnId = turn.id;
    }
  } else if (!state.finalTurn) {
    state.finalTurn = {
      id: state.turnId ?? "inferred-turn",
      status: "completed"
    };
  }

  if (options.inferred) {
    emitProgress(state.onProgress, "Turn completion inferred after the main thread finished and subagent work drained.", "finalizing");
  }

  state.resolveCompletion(state);
}

function rejectTurnCapture(state, error) {
  if (state.completed) {
    return;
  }
  clearCaptureTimers(state);
  state.completed = true;
  state.error = error;
  state.rejectCompletion(error);
}

function scheduleInferredCompletion(state) {
  if (state.completed || state.finalTurn || !state.finalAnswerSeen) {
    return;
  }

  if (state.pendingCollaborations.size > 0 || state.activeSubagentTurns.size > 0) {
    return;
  }

  clearCompletionTimer(state);
  state.completionTimer = setTimeout(() => {
    state.completionTimer = null;
    if (state.completed || state.finalTurn || !state.finalAnswerSeen) {
      return;
    }
    if (state.pendingCollaborations.size > 0 || state.activeSubagentTurns.size > 0) {
      return;
    }
    completeTurn(state, null, { inferred: true });
  }, 250);
  state.completionTimer.unref?.();
}

function belongsToTurn(state, message) {
  const messageThreadId = extractThreadId(message);
  if (!messageThreadId || !state.threadIds.has(messageThreadId)) {
    return false;
  }
  const trackedTurnId = state.threadTurnIds.get(messageThreadId) ?? null;
  const messageTurnId = extractTurnId(message);
  return trackedTurnId === null || messageTurnId === null || messageTurnId === trackedTurnId;
}

function recordItem(state, item, lifecycle, threadId = null) {
  if (item.type === "collabAgentToolCall") {
    if (!threadId || threadId === state.threadId) {
      if (lifecycle === "started" || item.status === "inProgress") {
        state.pendingCollaborations.add(item.id);
      } else if (lifecycle === "completed") {
        state.pendingCollaborations.delete(item.id);
        scheduleInferredCompletion(state);
      }
    }
    for (const receiverThreadId of item.receiverThreadIds ?? []) {
      registerThread(state, receiverThreadId);
    }
  }

  if (item.type === "agentMessage") {
    state.messages.push({
      lifecycle,
      phase: item.phase ?? null,
      text: item.text ?? ""
    });
    if (item.text) {
      if (!threadId || threadId === state.threadId) {
        state.lastAgentMessage = item.text;
        if (lifecycle === "completed" && item.phase === "final_answer") {
          state.finalAnswerSeen = true;
          scheduleInferredCompletion(state);
        }
      }
      if (lifecycle === "completed") {
        const sourceLabel = labelForThread(state, threadId);
        emitLogEvent(state.onProgress, {
          message: sourceLabel ? `Subagent ${sourceLabel}: ${shorten(item.text, 96)}` : `Assistant message captured: ${shorten(item.text, 96)}`,
          stderrMessage: null,
          phase: item.phase === "final_answer" ? "finalizing" : null,
          logTitle: sourceLabel ? `Subagent ${sourceLabel} message` : "Assistant message",
          logBody: item.text
        });
      }
    }
    return;
  }

  if (item.type === "exitedReviewMode") {
    state.reviewText = item.review ?? "";
    if (lifecycle === "completed" && item.review) {
      emitLogEvent(state.onProgress, {
        message: "Review output captured.",
        stderrMessage: null,
        phase: "finalizing",
        logTitle: "Review output",
        logBody: item.review
      });
    }
    return;
  }

  if (item.type === "reasoning" && lifecycle === "completed") {
    const nextSections = extractReasoningSections(item.summary);
    state.reasoningSummary = mergeReasoningSections(state.reasoningSummary, nextSections);
    if (nextSections.length > 0) {
      const sourceLabel = labelForThread(state, threadId);
      emitLogEvent(state.onProgress, {
        message: sourceLabel
          ? `Subagent ${sourceLabel} reasoning: ${shorten(nextSections[0], 96)}`
          : `Reasoning summary captured: ${shorten(nextSections[0], 96)}`,
        stderrMessage: null,
        logTitle: sourceLabel ? `Subagent ${sourceLabel} reasoning summary` : "Reasoning summary",
        logBody: nextSections.map((section) => `- ${section}`).join("\n")
      });
    }
    return;
  }

  if (item.type === "fileChange" && lifecycle === "completed") {
    state.fileChanges.push(item);
    return;
  }

  if (item.type === "commandExecution" && lifecycle === "completed") {
    state.commandExecutions.push(item);
  }
}

function applyTurnNotification(state, message) {
  switch (message.method) {
    case "thread/started":
      registerThread(state, message.params.thread.id, {
        threadName: message.params.thread.name,
        name: message.params.thread.name,
        agentNickname: message.params.thread.agentNickname,
        agentRole: message.params.thread.agentRole
      });
      break;
    case "thread/name/updated":
      registerThread(state, message.params.threadId, {
        threadName: message.params.threadName ?? null
      });
      break;
    case "turn/started":
      registerThread(state, message.params.threadId);
      state.threadTurnIds.set(message.params.threadId, message.params.turn.id);
      if ((message.params.threadId ?? null) !== state.threadId) {
        state.activeSubagentTurns.add(message.params.threadId);
      }
      emitProgress(
        state.onProgress,
        `Turn started (${message.params.turn.id}).`,
        "starting",
        (message.params.threadId ?? null) === state.threadId
          ? {
              threadId: message.params.threadId ?? null,
              turnId: message.params.turn.id ?? null
            }
          : {}
      );
      break;
    case "item/started":
      recordItem(state, message.params.item, "started", message.params.threadId ?? null);
      {
        const update = describeStartedItem(state, message.params.item);
        emitProgress(state.onProgress, update?.message, update?.phase ?? null);
      }
      break;
    case "item/completed":
      recordItem(state, message.params.item, "completed", message.params.threadId ?? null);
      {
        const update = describeCompletedItem(state, message.params.item);
        emitProgress(state.onProgress, update?.message, update?.phase ?? null);
      }
      break;
    case "thread/tokenUsage/updated":
      if ((message.params.threadId ?? null) === state.threadId) {
        state.tokenUsage = message.params.tokenUsage ?? null;
        state.modelContextWindow = message.params.tokenUsage?.modelContextWindow ?? null;
      }
      break;
    case "error": {
      const error = message.params.error ?? { message: "Unknown Codex turn error." };
      if (message.params.willRetry === true) {
        emitProgress(state.onProgress, `Codex error; retrying: ${error.message}`, "retrying");
        break;
      }
      if (message.params.threadId && message.params.threadId !== state.threadId) {
        emitProgress(state.onProgress, `Codex subagent error: ${error.message}`, "investigating");
        break;
      }
      state.error = error;
      emitProgress(state.onProgress, `Codex error: ${error.message}`, "failed");
      completeTurn(state, {
        id: message.params.turnId ?? state.turnId ?? "failed-turn",
        status: "failed",
        items: [],
        error
      });
      break;
    }
    case "turn/completed":
      if ((message.params.threadId ?? null) !== state.threadId) {
        state.activeSubagentTurns.delete(message.params.threadId);
        scheduleInferredCompletion(state);
        break;
      }
      emitProgress(
        state.onProgress,
        `Turn ${message.params.turn.status === "completed" ? "completed" : message.params.turn.status}.`,
        "finalizing"
      );
      completeTurn(state, message.params.turn);
      break;
    default:
      break;
  }
}

function interruptibleTurnId(state) {
  if (state.turnId) {
    return state.turnId;
  }
  for (let index = state.bufferedNotifications.length - 1; index >= 0; index -= 1) {
    const message = state.bufferedNotifications[index];
    if (message.method === "turn/started" && (message.params.threadId ?? null) === state.threadId) {
      return message.params.turn.id ?? null;
    }
  }
  return null;
}

function requestTurnInterrupt(client, state) {
  const turnId = interruptibleTurnId(state);
  if (!turnId) {
    return false;
  }
  try {
    void client.request("turn/interrupt", { threadId: state.threadId, turnId }).catch(() => {});
    return true;
  } catch {
    return false;
  }
}

function abortError(reason) {
  if (reason instanceof Error) {
    return reason;
  }
  const error = new Error(typeof reason === "string" && reason ? reason : "Codex turn was aborted.");
  error.name = "AbortError";
  return error;
}

function unexpectedClientExit(client, state) {
  if (!client.exitPromise) {
    return new Promise(() => {});
  }
  return Promise.resolve(client.exitPromise).then(
    () => {
      if (state.completed) {
        return state;
      }
      const exitDetail = client.exitError instanceof Error ? client.exitError.message : null;
      const stderr = cleanCodexStderr(client.stderr ?? "");
      const detail = exitDetail ?? stderr;
      throw new Error(
        `Codex app-server connection closed before the turn completed.${detail ? `\n${detail}` : ""}`
      );
    },
    (error) => {
      if (state.completed) {
        return state;
      }
      throw error instanceof Error
        ? error
        : new Error(`Codex app-server connection closed before the turn completed: ${String(error)}`);
    }
  );
}

/** @param {() => Promise<CaptureStartResponse>} startRequest */
async function captureTurn(client, threadId, startRequest, options = {}) {
  const state = createTurnCaptureState(threadId, options);
  const previousHandler = client.notificationHandler;
  const signal = options.signal ?? null;
  let abortHandler = null;

  client.setNotificationHandler((message) => {
    if (!state.turnId) {
      state.bufferedNotifications.push(message);
      return;
    }

    if (message.method === "thread/started" || message.method === "thread/name/updated") {
      applyTurnNotification(state, message);
      return;
    }

    if (!belongsToTurn(state, message)) {
        if (previousHandler) {
          previousHandler(message);
        }
        return;
    }

    applyTurnNotification(state, message);
  });

  try {
    abortHandler = () => {
      requestTurnInterrupt(client, state);
      rejectTurnCapture(state, abortError(signal?.reason));
    };
    if (signal?.aborted) {
      abortHandler();
      return await state.completion;
    }
    signal?.addEventListener("abort", abortHandler, { once: true });

    if (options.turnTimeoutMs) {
      state.turnTimeoutTimer = setTimeout(() => {
        const interruptRequested = requestTurnInterrupt(client, state);
        const error = /** @type {Error & { code: string, timeoutMs: number }} */ (
          new Error(
            `Codex turn timed out after ${options.turnTimeoutMs} ms${interruptRequested ? "; an interrupt was requested" : ""}.`
          )
        );
        error.code = "CODEX_TURN_TIMEOUT";
        error.timeoutMs = options.turnTimeoutMs;
        rejectTurnCapture(state, error);
      }, options.turnTimeoutMs);
      state.turnTimeoutTimer.unref?.();
    }

    const exitBeforeCompletion = unexpectedClientExit(client, state);
    const startOutcome = await Promise.race([
      Promise.resolve()
        .then(startRequest)
        .then((response) => /** @type {const} */ ({ type: "response", response })),
      state.completion.then(
        (completedState) => /** @type {const} */ ({ type: "completed", state: completedState })
      ),
      exitBeforeCompletion.then(
        (completedState) => /** @type {const} */ ({ type: "completed", state: completedState })
      )
    ]);
    if (startOutcome.type === "completed") {
      return startOutcome.state;
    }

    const response = startOutcome.response;
    options.onResponse?.(response, state);
    state.turnId = response.turn?.id ?? null;
    if (state.turnId) {
      state.threadTurnIds.set(state.threadId, state.turnId);
    }
    for (const message of state.bufferedNotifications) {
      if (belongsToTurn(state, message)) {
        applyTurnNotification(state, message);
      } else {
        if (previousHandler) {
          previousHandler(message);
        }
      }
    }
    state.bufferedNotifications.length = 0;

    if (response.turn?.status && response.turn.status !== "inProgress") {
      completeTurn(state, response.turn);
    }

    return await Promise.race([state.completion, exitBeforeCompletion]);
  } finally {
    clearCaptureTimers(state);
    if (abortHandler) {
      signal?.removeEventListener("abort", abortHandler);
    }
    client.setNotificationHandler(previousHandler ?? null);
  }
}

function useBroker(options = {}) {
  if (options.disableBroker !== undefined) {
    return !options.disableBroker;
  }
  const value = options.env?.[BROKER_OPT_IN_ENV] ?? process.env[BROKER_OPT_IN_ENV];
  return typeof value === "string" && ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

async function withAppServer(cwd, fn, options = {}) {
  let client = null;
  let fnStarted = false;
  const brokerEnabled = useBroker(options);
  try {
    client = await CodexAppServerClient.connect(cwd, {
      env: options.env,
      disableBroker: !brokerEnabled,
      useBroker: brokerEnabled
    });
    fnStarted = true;
    const result = await fn(client);
    await client.close();
    return result;
  } catch (error) {
    const brokerTransport = client?.transport === "broker" || error?.transport === "broker";
    const brokerRequested =
      brokerTransport ||
      Boolean(options.env?.[BROKER_ENDPOINT_ENV] ?? process.env[BROKER_ENDPOINT_ENV]);
    const shouldRetryDirect =
      (brokerTransport && !client?.hasAcceptedMutation && error?.rpcCode === BROKER_BUSY_RPC_CODE) ||
      (!fnStarted && brokerRequested &&
        (error?.brokerFatal === true || error?.code === "ENOENT" || error?.code === "ECONNREFUSED"));

    if (client) {
      await client.close().catch(() => {});
      client = null;
    }

    if (!shouldRetryDirect) {
      throw error;
    }

    const directClient = await CodexAppServerClient.connect(cwd, {
      env: options.env,
      disableBroker: true
    });
    try {
      return await fn(directClient);
    } finally {
      await directClient.close();
    }
  }
}

async function withDirectAppServer(cwd, fn, options = {}) {
  const client = await CodexAppServerClient.connect(cwd, {
    env: options.env,
    disableBroker: true
  });
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

function resolveCodexHome() {
  return path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
}

function sourceContentSha256(sourcePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(sourcePath)).digest("hex");
}

function importedThreadIdForSource(sourcePath) {
  const ledgerPath = path.join(resolveCodexHome(), "external_agent_session_imports.json");
  if (!fs.existsSync(ledgerPath)) {
    return null;
  }
  const ledger = readJsonFile(ledgerPath);
  const canonicalSource = fs.realpathSync(sourcePath);
  const contentSha256 = sourceContentSha256(canonicalSource);
  const records = Array.isArray(ledger?.records) ? ledger.records : [];
  const match = records
    .filter(
      (record) =>
        record?.source_path === canonicalSource &&
        record?.content_sha256 === contentSha256 &&
        typeof record?.imported_thread_id === "string"
    )
    .at(-1);
  return match?.imported_thread_id ?? null;
}

function externalAgentSessionMigration(sourcePath, cwd) {
  return {
    migrationItems: [
      {
        itemType: "SESSIONS",
        description: `Transfer Claude session ${path.basename(sourcePath)}`,
        cwd: null,
        details: {
          plugins: [],
          sessions: [{ path: sourcePath, cwd, title: null }],
          mcpServers: [],
          hooks: [],
          subagents: [],
          commands: []
        }
      }
    ]
  };
}

async function requestExternalAgentSessionImport(client, params) {
  const previousHandler = client.notificationHandler;
  let timeout = null;
  let resolveCompleted;
  let rejectCompleted;
  const completed = new Promise((resolve, reject) => {
    resolveCompleted = resolve;
    rejectCompleted = reject;
  });
  void completed.catch(() => {});

  client.setNotificationHandler((message) => {
    if (message.method === EXTERNAL_AGENT_IMPORT_COMPLETED) {
      resolveCompleted();
      return;
    }
    previousHandler?.(message);
  });
  timeout = setTimeout(() => {
    rejectCompleted(new Error("Timed out waiting for Codex to finish importing the Claude session."));
  }, EXTERNAL_AGENT_IMPORT_TIMEOUT_MS);

  try {
    await client.request("externalAgentConfig/import", params);
    await completed;
  } finally {
    clearTimeout(timeout);
    client.setNotificationHandler(previousHandler ?? null);
  }
}

async function startThread(client, cwd, options = {}) {
  const response = await client.request("thread/start", buildThreadParams(cwd, options));
  const threadId = response.thread.id;
  if (options.threadName) {
    try {
      await client.request("thread/name/set", { threadId, name: options.threadName });
    } catch (err) {
      // Only suppress "unknown variant/method" errors from older CLI versions
      // that don't support thread/name/set. Rethrow auth, network, or server errors.
      const msg = String(err?.message ?? err ?? "");
      if (!msg.includes("unknown variant") && !msg.includes("unknown method")) {
        throw err;
      }
    }
  }
  return response;
}

async function resumeThread(client, threadId, cwd, options = {}) {
  return client.request("thread/resume", buildResumeParams(threadId, cwd, options));
}

function canonicalWorkspacePath(workspacePath) {
  const resolved = path.resolve(workspacePath);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function sameWorkspacePath(left, right) {
  const canonicalLeft = canonicalWorkspacePath(left);
  const canonicalRight = canonicalWorkspacePath(right);
  if (process.platform === "win32") {
    return canonicalLeft.toLowerCase() === canonicalRight.toLowerCase();
  }
  return canonicalLeft === canonicalRight;
}

async function assertResumeWorkspace(client, threadId, cwd) {
  const response = await client.request("thread/read", {
    threadId,
    includeTurns: false
  });
  const sourceCwd = response.thread?.cwd;
  if (typeof sourceCwd !== "string" || !sourceCwd.trim()) {
    throw new Error(`Cannot safely resume Codex thread ${threadId}: its workspace path is unavailable.`);
  }
  if (!sameWorkspacePath(sourceCwd, cwd)) {
    throw new Error(
      `Cannot resume Codex thread ${threadId} in a different workspace. Thread workspace: ${sourceCwd}. Current workspace: ${cwd}. Run the command from the thread workspace, or start a new task with --fresh.`
    );
  }
}

function buildResultStatus(turnState) {
  return turnState.finalTurn?.status === "completed" ? 0 : 1;
}

const BUILTIN_PROVIDER_LABELS = new Map([
  ["openai", "OpenAI"],
  ["ollama", "Ollama"],
  ["lmstudio", "LM Studio"]
]);

function normalizeProviderId(value) {
  const providerId = typeof value === "string" ? value.trim() : "";
  return providerId || null;
}

function formatProviderLabel(providerId, providerConfig = null) {
  const configuredName = typeof providerConfig?.name === "string" ? providerConfig.name.trim() : "";
  if (configuredName) {
    return configuredName;
  }
  if (!providerId) {
    return "The active provider";
  }
  return BUILTIN_PROVIDER_LABELS.get(providerId) ?? providerId;
}

function buildAuthStatus(fields = {}) {
  return {
    available: true,
    loggedIn: false,
    detail: "not authenticated",
    source: "unknown",
    authMethod: null,
    verified: null,
    requiresOpenaiAuth: null,
    provider: null,
    ...fields
  };
}

function resolveProviderConfig(configResponse) {
  const config = configResponse?.config;
  if (!config || typeof config !== "object") {
    return {
      providerId: null,
      providerConfig: null
    };
  }

  const providerId = normalizeProviderId(config.model_provider);
  const providers =
    config.model_providers && typeof config.model_providers === "object" && !Array.isArray(config.model_providers)
      ? config.model_providers
      : null;
  const providerConfig =
    providerId && providers?.[providerId] && typeof providers[providerId] === "object" ? providers[providerId] : null;

  return {
    providerId,
    providerConfig
  };
}

function buildAppServerAuthStatus(accountResponse, configResponse) {
  const account = accountResponse?.account ?? null;
  const requiresOpenaiAuth =
    typeof accountResponse?.requiresOpenaiAuth === "boolean" ? accountResponse.requiresOpenaiAuth : null;
  const { providerId, providerConfig } = resolveProviderConfig(configResponse);
  const providerLabel = formatProviderLabel(providerId, providerConfig);

  if (account?.type === "chatgpt") {
    const email = typeof account.email === "string" && account.email.trim() ? account.email.trim() : null;
    return buildAuthStatus({
      loggedIn: true,
      detail: email ? `ChatGPT login active for ${email}` : "ChatGPT login active",
      source: "app-server",
      authMethod: "chatgpt",
      verified: true,
      requiresOpenaiAuth,
      provider: providerId
    });
  }

  if (account?.type === "apiKey") {
    return buildAuthStatus({
      loggedIn: true,
      detail: "API key configured (unverified)",
      source: "app-server",
      authMethod: "apiKey",
      verified: false,
      requiresOpenaiAuth,
      provider: providerId
    });
  }

  if (requiresOpenaiAuth === false) {
    return buildAuthStatus({
      loggedIn: true,
      detail: `${providerLabel} is configured and does not require OpenAI authentication`,
      source: "app-server",
      requiresOpenaiAuth,
      provider: providerId
    });
  }

  return buildAuthStatus({
    loggedIn: false,
    detail: `${providerLabel} requires OpenAI authentication`,
    source: "app-server",
    requiresOpenaiAuth,
    provider: providerId
  });
}

async function getCodexAuthStatusFromClient(client, cwd) {
  try {
    const accountResponse = await client.request("account/read", { refreshToken: false });
    const configResponse = await client.request("config/read", {
      includeLayers: false,
      cwd
    });

    return buildAppServerAuthStatus(accountResponse, configResponse);
  } catch (error) {
    return buildAuthStatus({
      loggedIn: false,
      detail: error instanceof Error ? error.message : String(error),
      source: "app-server"
    });
  }
}

export function getCodexAvailability(cwd, env = process.env) {
  const codexBinary = resolveCodexBinary(env);
  const versionStatus = binaryAvailable(codexBinary, ["--version"], { cwd, env });
  if (!versionStatus.available) {
    return versionStatus;
  }

  const appServerStatus = binaryAvailable(codexBinary, ["app-server", "--help"], { cwd, env });
  if (!appServerStatus.available) {
    return {
      available: false,
      detail: `${versionStatus.detail}; advanced runtime unavailable: ${appServerStatus.detail}`
    };
  }

  return {
    available: true,
    detail: `${versionStatus.detail}; advanced runtime available`
  };
}

export function getSessionRuntimeStatus(env = process.env, cwd = process.cwd()) {
  const brokerEnabled = useBroker({ env });
  if (brokerEnabled) {
    const endpoint = env?.[BROKER_ENDPOINT_ENV] ?? loadBrokerSession(cwd)?.endpoint ?? null;
    return {
      mode: "shared",
      label: "shared session",
      detail: endpoint
        ? "This Claude session is configured to reuse one shared Codex runtime."
        : "This Claude session will start and reuse one shared Codex runtime on demand.",
      endpoint
    };
  }

  return {
    mode: "direct",
    label: "direct per-job process",
    detail: "Each review or task uses its own Codex app-server process and closes it when the run finishes.",
    endpoint: null
  };
}

export async function getCodexAuthStatus(cwd, options = {}) {
  const availability = getCodexAvailability(cwd, options.env);
  if (!availability.available) {
    return {
      available: false,
      loggedIn: false,
      detail: availability.detail,
      source: "availability",
      authMethod: null,
      verified: null,
      requiresOpenaiAuth: null,
      provider: null
    };
  }

  let client = null;
  try {
    const brokerEnabled = useBroker({ env: options.env, disableBroker: options.disableBroker });
    client = await CodexAppServerClient.connect(cwd, {
      env: options.env,
      disableBroker: !brokerEnabled,
      useBroker: brokerEnabled,
      reuseExistingBroker: brokerEnabled
    });
    return await getCodexAuthStatusFromClient(client, cwd);
  } catch (error) {
    return buildAuthStatus({
      loggedIn: false,
      detail: error instanceof Error ? error.message : String(error),
      source: "app-server"
    });
  } finally {
    if (client) {
      await client.close().catch(() => {});
    }
  }
}

export async function interruptAppServerTurn(cwd, { threadId, turnId }) {
  if (!threadId || !turnId) {
    return {
      attempted: false,
      interrupted: false,
      transport: null,
      detail: "missing threadId or turnId"
    };
  }

  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    return {
      attempted: false,
      interrupted: false,
      transport: null,
      detail: availability.detail
    };
  }

  let client = null;
  try {
    client = await CodexAppServerClient.connect(cwd, { reuseExistingBroker: true });
    await client.request("turn/interrupt", { threadId, turnId });
    return {
      attempted: true,
      interrupted: true,
      transport: client.transport,
      detail: `Interrupted ${turnId} on ${threadId}.`
    };
  } catch (error) {
    return {
      attempted: true,
      interrupted: false,
      transport: client?.transport ?? null,
      detail: error instanceof Error ? error.message : String(error)
    };
  } finally {
    await client?.close().catch(() => {});
  }
}

export async function runAppServerReview(cwd, options = {}) {
  const resolvedSettings = options.settings ?? resolveRuntimeSettings({ ...options, env: options.env });
  const settings = {
    ...resolvedSettings,
    headless: Boolean(options.headless ?? resolvedSettings.headless)
  };
  const availability = getCodexAvailability(cwd, options.env);
  if (!availability.available) {
    throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/codex:setup`.");
  }

  return withAppServer(cwd, async (client) => {
    emitProgress(options.onProgress, "Starting Codex review thread.", "starting");
    const threadResponse = await startThread(client, cwd, {
      model: settings.model,
      sandbox: "read-only",
      ephemeral: true,
      threadName: options.threadName,
      config: buildRuntimeConfig(settings, { headless: settings.headless }),
      developerInstructions: buildDeveloperInstructions(settings, {
        reviewOnly: true,
        headless: settings.headless,
        developerInstructions: options.developerInstructions
      })
    });
    const sourceThreadId = threadResponse.thread.id;
    emitProgress(options.onProgress, `Thread ready (${sourceThreadId}).`, "starting", {
      threadId: sourceThreadId
    });
    const delivery = options.delivery ?? "inline";

    const turnState = await captureTurn(
      client,
      sourceThreadId,
      () =>
        client.request("review/start", {
          threadId: sourceThreadId,
          delivery,
          target: options.target
        }),
      {
        onProgress: options.onProgress,
        signal: options.signal,
        turnTimeoutMs: settings.turnTimeoutMs,
        onResponse(response, state) {
          if (response.reviewThreadId) {
            state.threadIds.add(response.reviewThreadId);
            if (delivery === "detached") {
              state.threadId = response.reviewThreadId;
            }
          }
        }
      }
    );

    return {
      status: buildResultStatus(turnState),
      threadId: turnState.threadId,
      sourceThreadId,
      turnId: turnState.turnId,
      reviewText: turnState.reviewText,
      reasoningSummary: turnState.reasoningSummary,
      runtime: buildRuntimeMetadata(threadResponse, settings, turnState),
      turn: turnState.finalTurn,
      error: turnState.error,
      stderr: cleanCodexStderr(client.stderr)
    };
  }, { env: options.env, disableBroker: options.disableBroker });
}

export async function importExternalAgentSession(cwd, options = {}) {
  const availability = getCodexAvailability(cwd, options.env);
  if (!availability.available) {
    throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/codex:setup`.");
  }
  if (!options.sourcePath) {
    throw new Error("A Claude session source path is required.");
  }

  return withDirectAppServer(cwd, async (client) => {
    emitProgress(options.onProgress, "Importing Claude session into Codex.", "transferring");
    try {
      await requestExternalAgentSessionImport(client, externalAgentSessionMigration(options.sourcePath, cwd));
    } catch (error) {
      if (error?.rpcCode === -32601) {
        throw new Error(
          "This Codex version does not support Claude session transfer. Update Codex with `npm install -g @openai/codex@latest`, then retry.",
          { cause: error }
        );
      }
      throw error;
    }
    const threadId = importedThreadIdForSource(options.sourcePath);
    if (!threadId) {
      const stderr = cleanCodexStderr(client.stderr);
      throw new Error(
        `Codex reported that the Claude import completed, but did not record an imported thread.${stderr ? `\n${stderr}` : " Check the Codex app-server logs for the underlying import error."}`
      );
    }
    emitProgress(options.onProgress, `Claude session imported (${threadId}).`, "completed", { threadId });
    return {
      threadId,
      stderr: cleanCodexStderr(client.stderr)
    };
  }, { env: options.env });
}

export async function runAppServerTurn(cwd, options = {}) {
  const resolvedSettings = options.settings ?? resolveRuntimeSettings({ ...options, env: options.env });
  const settings = {
    ...resolvedSettings,
    headless: Boolean(options.headless ?? resolvedSettings.headless)
  };
  const reviewOnly = Boolean(options.reviewOnly);
  const availability = getCodexAvailability(cwd, options.env);
  if (!availability.available) {
    throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/codex:setup`.");
  }

  return withAppServer(cwd, async (client) => {
    let threadId;
    let threadResponse;
    const sandbox = reviewOnly ? "read-only" : options.sandbox;
    const config = buildRuntimeConfig(settings, { headless: settings.headless });
    const developerInstructions = buildDeveloperInstructions(settings, {
      reviewOnly,
      headless: settings.headless,
      developerInstructions: options.developerInstructions
    });

    if (options.resumeThreadId) {
      emitProgress(options.onProgress, `Resuming thread ${options.resumeThreadId}.`, "starting");
      await assertResumeWorkspace(client, options.resumeThreadId, cwd);
      threadResponse = await resumeThread(client, options.resumeThreadId, cwd, {
        model: settings.model,
        sandbox,
        config,
        developerInstructions
      });
      threadId = threadResponse.thread.id;
    } else {
      emitProgress(options.onProgress, "Starting Codex task thread.", "starting");
      threadResponse = await startThread(client, cwd, {
        model: settings.model,
        sandbox,
        ephemeral: reviewOnly || settings.headless ? true : options.persistThread ? false : true,
        threadName: reviewOnly
          ? null
          : options.persistThread
            ? options.threadName
            : options.threadName ?? null,
        config,
        developerInstructions
      });
      threadId = threadResponse.thread.id;
    }

    emitProgress(options.onProgress, `Thread ready (${threadId}).`, "starting", {
      threadId
    });

    const prompt = options.prompt?.trim() || options.defaultPrompt || "";
    if (!prompt) {
      throw new Error("A prompt is required for this Codex run.");
    }

    const turnState = await captureTurn(
      client,
      threadId,
      () =>
        client.request("turn/start", {
          threadId,
          input: buildTurnInput(prompt),
          model: settings.model,
          effort: settings.effort,
          outputSchema: options.outputSchema ?? null
        }),
      {
        onProgress: options.onProgress,
        signal: options.signal,
        turnTimeoutMs: settings.turnTimeoutMs
      }
    );

    return {
      status: buildResultStatus(turnState),
      threadId,
      turnId: turnState.turnId,
      finalMessage: turnState.lastAgentMessage,
      reasoningSummary: turnState.reasoningSummary,
      runtime: buildRuntimeMetadata(threadResponse, settings, turnState),
      turn: turnState.finalTurn,
      error: turnState.error,
      stderr: cleanCodexStderr(client.stderr),
      fileChanges: turnState.fileChanges,
      touchedFiles: collectTouchedFiles(turnState.fileChanges),
      commandExecutions: turnState.commandExecutions
    };
  }, { env: options.env, disableBroker: options.disableBroker });
}

export async function findLatestTaskThread(cwd) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/codex:setup`.");
  }

  return withAppServer(cwd, async (client) => {
    const response = await client.request("thread/list", {
      cwd,
      limit: 20,
      sortKey: "updated_at",
      sourceKinds: ["appServer"],
      searchTerm: TASK_THREAD_PREFIX
    });

    return (
      response.data.find((thread) => typeof thread.name === "string" && thread.name.startsWith(TASK_THREAD_PREFIX)) ??
      null
    );
  });
}

export function buildPersistentTaskThreadName(prompt) {
  return buildTaskThreadName(prompt);
}

export function parseStructuredOutput(rawOutput, fallback = {}) {
  if (!rawOutput) {
    return {
      parsed: null,
      parseError: fallback.failureMessage ?? "Codex did not return a final structured message.",
      rawOutput: rawOutput ?? "",
      ...fallback
    };
  }

  try {
    return {
      parsed: JSON.parse(rawOutput),
      parseError: null,
      rawOutput,
      ...fallback
    };
  } catch (error) {
    return {
      parsed: null,
      parseError: error.message,
      rawOutput,
      ...fallback
    };
  }
}

export function readOutputSchema(schemaPath) {
  return readJsonFile(schemaPath);
}

export { DEFAULT_CONTINUE_PROMPT, TASK_THREAD_PREFIX };
