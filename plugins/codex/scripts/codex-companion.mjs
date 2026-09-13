#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs } from "./lib/args.mjs";
import {
    buildPersistentTaskThreadName,
    DEFAULT_CONTINUE_PROMPT,
    findLatestTaskThread,
    getCodexAuthStatus,
    getCodexAvailability,
    getSessionRuntimeStatus,
    importExternalAgentSession,
    interruptAppServerTurn,
    parseStructuredOutput,
    readOutputSchema,
    runAppServerReview,
    runAppServerTurn
  } from "./lib/codex.mjs";
import { resolveClaudeSessionPath } from "./lib/claude-session-transfer.mjs";
import { readStdinIfPiped } from "./lib/fs.mjs";
import { collectReviewContext, ensureGitRepository, resolveReviewTarget } from "./lib/git.mjs";
import { binaryAvailable, resolveCodexBinary } from "./lib/process.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import {
  generateJobId,
  cancelJob,
  getConfig,
  listJobs,
  setConfig,
  upsertJob,
  writeJobFile
} from "./lib/state.mjs";
import {
  buildSingleJobSnapshot,
  buildStatusSnapshot,
  readStoredJob,
  resolveCancelableJob,
  resolveResultJob,
  sortJobsNewestFirst
} from "./lib/job-control.mjs";
import {
  appendLogLine,
  createJobLogFile,
  createJobProgressUpdater,
  createJobRecord,
  createProgressReporter,
  nowIso,
  runTrackedJob,
  SESSION_ID_ENV
} from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import { resolveRuntimeSettings } from "./lib/runtime-settings.mjs";
import { prepareReviewWorkspace, normalizeReviewPaths } from "./lib/review-workspace.mjs";
import {
  renderNativeReviewResult,
  renderReviewResult,
  renderStoredJobResult,
  renderCancelReport,
  renderJobStatusReport,
  renderSetupReport,
  renderStatusReport,
  renderTaskResult,
  validateReviewResultShape
} from "./lib/render.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const REVIEW_SCHEMA = path.join(ROOT_DIR, "schemas", "review-output.schema.json");
const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 3 * 60 * 60 * 1000;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 2000;
const DEFAULT_JOB_TIMEOUT_MS = 3 * 60 * 60 * 1000;
const RUNTIME_VALUE_OPTIONS = ["model", "effort", "context-window", "auto-compact-token-limit", "turn-timeout-ms", "job-timeout-ms", "agent-timeout-seconds"];

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/codex-companion.mjs setup [--enable-review-gate|--disable-review-gate] [--json]",
      "  node scripts/codex-companion.mjs review [--wait|--background] [--headless] [--base <ref>] [--scope <auto|working-tree|branch>] [--prompt-file <path>] [--output-file <path>] [focus]",
      "  node scripts/codex-companion.mjs adversarial-review [--wait|--background] [--headless] [--base <ref>] [--scope <auto|working-tree|branch>] [focus]",
      "  node scripts/codex-companion.mjs task [--wait|--background] [--write] [--resume <thread-id>|--resume-last|--fresh] [--prompt-file <path>] [prompt]",
      "  node scripts/codex-companion.mjs transfer [--source <claude-jsonl>] [--json]",
      "  node scripts/codex-companion.mjs status [job-id] [--all] [--json]",
      "  node scripts/codex-companion.mjs result [job-id] [--json]",
      "  node scripts/codex-companion.mjs cancel [job-id] [--json]",
      "",
      "Tasks and reviews detach by default. --wait waits for the durable job; closing the caller does not cancel it.",
      "Runtime flags: --model <astra|sol|luna|terra|spark|model-id> --effort <none|minimal|low|medium|high|xhigh|max|ultra>",
      "  --context-window <tokens> --auto-compact-token-limit <tokens> --multi-agent",
      "  --turn-timeout-ms <ms> --job-timeout-ms <ms> --agent-timeout-seconds <seconds>",
      "Defaults: Astra / ultra, context 1000000, compaction 800000, turn/job 3 hours, agent 9600 seconds.",
      "Use status <job-id> --wait, then result <job-id>. Help never starts a job.",
      "Safe invocations: <subcommand> --args-file <file.json> reads a JSON array of string arguments without shell interpolation."
    ].join("\n")
  );
}

function outputResult(value, asJson) {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    process.stdout.write(value);
  }
}

function outputCommandResult(payload, rendered, asJson) {
  outputResult(asJson ? payload : rendered, asJson);
}

function positiveInteger(value, fallback, flag) {
  if (value == null) return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0 || number > 2147483647) {
    throw new Error(`${flag} must be a positive integer no greater than 2147483647.`);
  }
  return number;
}

function runtimeSettings(options) {
  return resolveRuntimeSettings({
    model: options.model,
    effort: options.effort,
    contextWindow: options["context-window"],
    autoCompactTokenLimit: options["auto-compact-token-limit"],
    turnTimeoutMs: options["turn-timeout-ms"],
    agentTimeoutSeconds: options["agent-timeout-seconds"],
    multiAgent: options["multi-agent"],
    headless: options.headless
  });
}

function jobTimeout(options) {
  return positiveInteger(options["job-timeout-ms"] ?? process.env.CODEX_COMPANION_JOB_TIMEOUT_MS, DEFAULT_JOB_TIMEOUT_MS, "--job-timeout-ms");
}

function validateExecutionMode(options) {
  if (options.wait && options.background) throw new Error("Choose either --wait or --background.");
}

function readInvocationArgs(argv) {
  if (argv[0] === "--args-file") {
    const consume = argv.length === 3 && argv[2] === "--consume-args-file";
    if (argv.length !== 2 && !consume) throw new Error("--args-file requires one JSON file path and optional --consume-args-file.");
    const args = JSON.parse(fs.readFileSync(path.resolve(argv[1]), "utf8"));
    if (!Array.isArray(args) || !args.every(arg => typeof arg === "string")) {
      throw new Error("The arguments file must contain a JSON array of strings.");
    }
    if (consume) fs.unlinkSync(path.resolve(argv[1]));
    return args;
  }
  return argv;
}

function parseCommandInput(argv, config = {}) {
  return parseArgs(argv, {
    ...config,
    aliasMap: {
      C: "cwd",
      ...(config.aliasMap ?? {})
    }
  });
}

function resolveCommandCwd(options = {}) {
  return options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
}

function resolveCommandWorkspace(options = {}) {
  return resolveWorkspaceRoot(resolveCommandCwd(options));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shorten(text, limit = 96) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function firstMeaningfulLine(text, fallback) {
  const line = String(text ?? "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean);
  return line ?? fallback;
}

async function buildSetupReport(cwd, actionsTaken = []) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const nodeStatus = binaryAvailable("node", ["--version"], { cwd });
  const npmStatus = binaryAvailable("npm", ["--version"], { cwd });
  const codexStatus = getCodexAvailability(cwd);
  const authStatus = await getCodexAuthStatus(cwd);
  const config = getConfig(workspaceRoot);

  const nextSteps = [];
  if (!codexStatus.available) {
    nextSteps.push("Install Codex with `npm install -g @openai/codex`.");
  }
  if (codexStatus.available && !authStatus.loggedIn && authStatus.requiresOpenaiAuth) {
    nextSteps.push("Run `!codex login`.");
    nextSteps.push("If browser login is blocked, retry with `!codex login --device-auth` or `!codex login --with-api-key`.");
  }
  if (!config.stopReviewGate) {
    nextSteps.push("Optional: run `/codex:setup --enable-review-gate` to require a fresh review before stop.");
  }

  return {
    ready: nodeStatus.available && codexStatus.available && authStatus.loggedIn,
    node: { ...nodeStatus, executable: process.execPath },
    npm: npmStatus,
    codex: { ...codexStatus, executable: resolveCodexBinary() },
    defaults: resolveRuntimeSettings(),
    auth: authStatus,
    sessionRuntime: getSessionRuntimeStatus(process.env, workspaceRoot),
    reviewGateEnabled: Boolean(config.stopReviewGate),
    actionsTaken,
    nextSteps
  };
}

async function handleSetup(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "enable-review-gate", "disable-review-gate"]
  });

  if (options["enable-review-gate"] && options["disable-review-gate"]) {
    throw new Error("Choose either --enable-review-gate or --disable-review-gate.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const actionsTaken = [];

  if (options["enable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", true);
    actionsTaken.push(`Enabled the stop-time review gate for ${workspaceRoot}.`);
  } else if (options["disable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", false);
    actionsTaken.push(`Disabled the stop-time review gate for ${workspaceRoot}.`);
  }

  const finalReport = await buildSetupReport(cwd, actionsTaken);
  outputResult(options.json ? finalReport : renderSetupReport(finalReport), options.json);
}

function buildAdversarialReviewPrompt(context, focusText) {
  const template = loadPromptTemplate(ROOT_DIR, "adversarial-review");
  return interpolateTemplate(template, {
    REVIEW_KIND: "Adversarial Review",
    TARGET_LABEL: context.target.label,
    USER_FOCUS: focusText || "No extra focus provided.",
    REVIEW_COLLECTION_GUIDANCE: context.collectionGuidance,
    REVIEW_INPUT: context.content
  });
}

function ensureCodexAvailable(cwd) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/codex:setup`.");
  }
}

function buildNativeReviewTarget(target) {
  if (target.mode === "working-tree") {
    return { type: "uncommittedChanges" };
  }

  if (target.mode === "branch") {
    return { type: "baseBranch", branch: target.baseRef };
  }

  return null;
}

function validateNativeReviewRequest(target, focusText) {
  if (focusText.trim()) {
    throw new Error(
      `\`/codex:review\` now maps directly to the built-in reviewer and does not support custom focus text. Retry with \`/codex:adversarial-review ${focusText.trim()}\` for focused review instructions.`
    );
  }

  const nativeTarget = buildNativeReviewTarget(target);
  if (!nativeTarget) {
    throw new Error("This `/codex:review` target is not supported by the built-in reviewer. Retry with `/codex:adversarial-review` for custom targeting.");
  }

  return nativeTarget;
}

function renderStatusPayload(report, asJson) {
  return asJson ? report : renderStatusReport(report);
}

function isActiveJobStatus(status) {
  return status === "queued" || status === "running";
}

function getCurrentClaudeSessionId() {
  return process.env[SESSION_ID_ENV] ?? null;
}

function filterJobsForCurrentClaudeSession(jobs) {
  const sessionId = getCurrentClaudeSessionId();
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

function findLatestResumableTaskJob(jobs) {
  return (
    jobs.find(
      (job) =>
        job.jobClass === "task" &&
        job.threadId &&
        job.status !== "queued" &&
        job.status !== "running"
    ) ?? null
  );
}

async function waitForSingleJobSnapshot(cwd, reference, options = {}) {
  const timeoutMs = Math.max(0, Number(options.timeoutMs) || DEFAULT_STATUS_WAIT_TIMEOUT_MS);
  const pollIntervalMs = Math.max(100, Number(options.pollIntervalMs) || DEFAULT_STATUS_POLL_INTERVAL_MS);
  const deadline = Date.now() + timeoutMs;
  let snapshot = buildSingleJobSnapshot(cwd, reference);

  while (isActiveJobStatus(snapshot.job.status) && Date.now() < deadline) {
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    snapshot = buildSingleJobSnapshot(cwd, reference);
  }

  return {
    ...snapshot,
    waitTimedOut: isActiveJobStatus(snapshot.job.status),
    timeoutMs
  };
}

async function resolveLatestTrackedTaskThread(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const sessionId = getCurrentClaudeSessionId();
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot)).filter((job) => job.id !== options.excludeJobId);
  const visibleJobs = filterJobsForCurrentClaudeSession(jobs);
  const activeTask = visibleJobs.find((job) => job.jobClass === "task" && (job.status === "queued" || job.status === "running"));
  if (activeTask) {
    throw new Error(`Task ${activeTask.id} is still running. Use /codex:status before continuing it.`);
  }

  const trackedTask = findLatestResumableTaskJob(visibleJobs);
  if (trackedTask) {
    return { id: trackedTask.threadId };
  }

  if (sessionId) {
    return null;
  }

  return findLatestTaskThread(workspaceRoot);
}

async function executeReviewRun(request) {
  const target = request.target ?? resolveReviewTarget(request.cwd, { base: request.base, scope: request.scope });
  const snapshot = request.headless ? await prepareReviewWorkspace(request.cwd, target) : null;
  try {
    const execution = await executeReviewInWorkspace({
      ...request,
      cwd: snapshot?.cwd ?? request.cwd,
      target: snapshot?.target ?? target
    });
    if (snapshot) {
      execution.rendered = normalizeReviewPaths(execution.rendered, snapshot.cwd, request.cwd);
      execution.payload = JSON.parse(normalizeReviewPaths(JSON.stringify(execution.payload), snapshot.cwd, request.cwd));
      if (execution.payload.context) execution.payload.context.repoRoot = ensureGitRepository(request.cwd);
    }
    if (request.outputFile) {
      fs.mkdirSync(path.dirname(request.outputFile), { recursive: true });
      fs.writeFileSync(request.outputFile, execution.rendered, "utf8");
      execution.payload.outputFile = request.outputFile;
    }
    return execution;
  } finally {
    await snapshot?.cleanup();
  }
}

async function executeReviewInWorkspace(request) {
  ensureCodexAvailable(request.cwd);
  ensureGitRepository(request.cwd);

  const target = request.target ?? resolveReviewTarget(request.cwd, {
    base: request.base,
    scope: request.scope
  });
  const focusText = request.focusText?.trim() ?? "";
  const reviewName = request.reviewName ?? "Review";
  if (reviewName === "Review" && !request.headless) {
    const reviewTarget = validateNativeReviewRequest(target, focusText);
    const result = await runAppServerReview(request.cwd, {
      target: reviewTarget,
      settings: request.settings,
      signal: request.signal,
      onProgress: request.onProgress
    });
    const payload = {
      review: reviewName,
      target,
      threadId: result.threadId,
      sourceThreadId: result.sourceThreadId,
      runtime: result.runtime,
      error: result.error,
      codex: {
        status: result.status,
        stderr: result.stderr,
        stdout: result.reviewText,
        reasoning: result.reasoningSummary
      }
    };
    const rendered = renderNativeReviewResult(
      {
        status: result.status,
        stdout: result.reviewText,
        stderr: result.stderr
      },
      { reviewLabel: reviewName, targetLabel: target.label, reasoningSummary: result.reasoningSummary }
    );

    return {
      exitStatus: result.status,
      threadId: result.threadId,
      turnId: result.turnId,
      payload,
      rendered,
      summary: firstMeaningfulLine(result.reviewText, `${reviewName} completed.`),
      jobTitle: `Codex ${reviewName}`,
      jobClass: "review",
      targetLabel: target.label
    };
  }

  const context = collectReviewContext(request.cwd, target);
  const prompt = buildAdversarialReviewPrompt(context, focusText);
  const result = await runAppServerTurn(context.repoRoot, {
    prompt,
    settings: request.settings,
    signal: request.signal,
    reviewOnly: true,
    headless: request.headless,
    sandbox: "read-only",
    outputSchema: readOutputSchema(REVIEW_SCHEMA),
    onProgress: request.onProgress
  });
  const parsed = parseStructuredOutput(result.finalMessage, {
    status: result.status,
    failureMessage: result.error?.message ?? result.stderr
  });
  if (!parsed.parseError) parsed.parseError = validateReviewResultShape(parsed.parsed);
  const exitStatus = result.status !== 0 || parsed.parseError ? 1 : 0;
  const payload = {
    review: reviewName,
    target,
    threadId: result.threadId,
    runtime: result.runtime,
    error: result.error ?? (parsed.parseError ? { message: `Invalid review output: ${parsed.parseError}` } : null),
    context: {
      repoRoot: context.repoRoot,
      branch: context.branch,
      summary: context.summary
    },
    codex: {
      status: result.status,
      stderr: result.stderr,
      stdout: result.finalMessage,
      reasoning: result.reasoningSummary
    },
    result: parsed.parsed,
    rawOutput: parsed.rawOutput,
    parseError: parsed.parseError,
    reasoningSummary: result.reasoningSummary
  };

  return {
    exitStatus,
    threadId: result.threadId,
    turnId: result.turnId,
    payload,
    rendered: renderReviewResult(parsed, {
      reviewLabel: reviewName,
      targetLabel: context.target.label,
      reasoningSummary: result.reasoningSummary
    }),
    summary: parsed.parsed?.summary ?? parsed.parseError ?? firstMeaningfulLine(result.finalMessage, `${reviewName} finished.`),
    jobTitle: `Codex ${reviewName}`,
    jobClass: "review",
    targetLabel: context.target.label
  };
}


async function executeTaskRun(request) {
  const workspaceRoot = resolveWorkspaceRoot(request.cwd);
  ensureCodexAvailable(request.cwd);

  const taskMetadata = buildTaskRunMetadata({
    prompt: request.prompt,
    resumeLast: request.resumeLast,
    stopReview: request.stopReview
  });

  let resumeThreadId = request.resumeThreadId ?? null;
  if (!resumeThreadId && request.resumeLast) {
    const latestThread = await resolveLatestTrackedTaskThread(workspaceRoot, {
      excludeJobId: request.jobId
    });
    if (!latestThread) {
      throw new Error("No previous Codex task thread was found for this repository.");
    }
    resumeThreadId = latestThread.id;
  }

  if (!request.prompt && !resumeThreadId) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }

  const result = await runAppServerTurn(workspaceRoot, {
    resumeThreadId,
    prompt: request.prompt,
    defaultPrompt: resumeThreadId ? DEFAULT_CONTINUE_PROMPT : "",
    settings: request.settings,
    signal: request.signal,
    sandbox: request.write ? "workspace-write" : "read-only",
    reviewOnly: Boolean(request.stopReview),
    onProgress: request.onProgress,
    persistThread: !request.stopReview,
    threadName: resumeThreadId ? null : buildPersistentTaskThreadName(request.prompt || DEFAULT_CONTINUE_PROMPT)
  });

  const rawOutput = typeof result.finalMessage === "string" ? result.finalMessage : "";
  const failureMessage = result.error?.message ?? result.stderr ?? "";
  const rendered = renderTaskResult(
    {
      rawOutput,
      failureMessage,
      reasoningSummary: result.reasoningSummary
    },
    {
      title: taskMetadata.title,
      jobId: request.jobId ?? null,
      write: Boolean(request.write)
    }
  );
  const payload = {
    status: result.status,
    threadId: result.threadId,
    runtime: result.runtime,
    error: result.error,
    rawOutput,
    touchedFiles: result.touchedFiles,
    reasoningSummary: result.reasoningSummary
  };

  return {
    exitStatus: result.status,
    threadId: result.threadId,
    turnId: result.turnId,
    payload,
    rendered,
    summary: firstMeaningfulLine(rawOutput, firstMeaningfulLine(failureMessage, `${taskMetadata.title} finished.`)),
    jobTitle: taskMetadata.title,
    jobClass: "task",
    write: Boolean(request.write)
  };
}

function buildReviewJobMetadata(reviewName, target) {
  return {
    kind: reviewName === "Adversarial Review" ? "adversarial-review" : "review",
    title: reviewName === "Review" ? "Codex Review" : `Codex ${reviewName}`,
    summary: `${reviewName} ${target.label}`
  };
}

function buildTaskRunMetadata({ prompt, resumeLast = false, stopReview = false }) {
  if (stopReview) {
    return {
      stopReview: true,
      title: "Codex Stop Gate Review",
      summary: "Stop-gate review of previous Claude turn"
    };
  }

  const title = resumeLast ? "Codex Resume" : "Codex Task";
  const fallbackSummary = resumeLast ? DEFAULT_CONTINUE_PROMPT : "Task";
  return {
    title,
    summary: shorten(prompt || fallbackSummary)
  };
}

function renderQueuedTaskLaunch(payload) {
  return `${payload.title} started in the background as ${payload.jobId}.\nWait: /codex:status ${payload.jobId} --wait\nResult: /codex:result ${payload.jobId}\nLog: ${payload.logFile}\n`;
}

function getJobKindLabel(kind, jobClass) {
  if (kind === "adversarial-review") {
    return "adversarial-review";
  }
  return jobClass === "review" ? "review" : "rescue";
}

function createCompanionJob({ prefix, kind, title, workspaceRoot, jobClass, summary, write = false }) {
  return createJobRecord({
    id: generateJobId(prefix),
    kind,
    kindLabel: getJobKindLabel(kind, jobClass),
    title,
    workspaceRoot,
    jobClass,
    summary,
    write
  });
}

function createTrackedProgress(job, options = {}) {
  const logFile = options.logFile ?? createJobLogFile(job.workspaceRoot, job.id, job.title);
  return {
    logFile,
    progress: createProgressReporter({
      stderr: Boolean(options.stderr),
      logFile,
      onEvent: createJobProgressUpdater(job.workspaceRoot, job.id)
    })
  };
}

function buildTaskJob(workspaceRoot, taskMetadata, write) {
  return createCompanionJob({
    prefix: taskMetadata.stopReview ? "review" : "task",
    kind: taskMetadata.stopReview ? "stop-review" : "task",
    title: taskMetadata.title,
    workspaceRoot,
    jobClass: taskMetadata.stopReview ? "review" : "task",
    summary: taskMetadata.summary,
    write
  });
}

function buildTaskRequest({ cwd, settings, prompt, write, resumeLast, resumeThreadId, jobId, jobTimeoutMs, stopReview }) {
  return {
    cwd,
    settings,
    prompt,
    write,
    resumeLast,
    resumeThreadId,
    jobId,
    jobTimeoutMs,
    stopReview
  };
}

function renderTransferResult(payload) {
  const lines = [
    "Transferred the Claude session into a Codex thread with visible turn history.",
    `Codex session ID: ${payload.threadId}`,
    `Resume in Codex: ${payload.resumeCommand}`
  ];
  return `${lines.join("\n")}\n`;
}

async function executeTransfer(cwd, options = {}) {
  const sourcePath = resolveClaudeSessionPath(cwd, {
    source: options.source
  });
  const result = await importExternalAgentSession(cwd, { sourcePath });
  const payload = {
    threadId: result.threadId,
    resumeCommand: `codex resume ${result.threadId}`,
    sourcePath,
    sessionId: path.basename(sourcePath, ".jsonl")
  };

  return {
    payload,
    rendered: renderTransferResult(payload)
  };
}

function readTaskPrompt(cwd, options, positionals) {
  if (options["prompt-file"]) {
    return fs.readFileSync(path.resolve(cwd, options["prompt-file"]), "utf8");
  }

  const positionalPrompt = positionals.join(" ");
  return positionalPrompt || readStdinIfPiped();
}

function requireTaskRequest(prompt, resumeLast) {
  if (!prompt && !resumeLast) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }
}

async function dispatchJob(cwd, job, request, options = {}) {
  ensureCodexAvailable(cwd);
  const { payload } = enqueueBackgroundTask(cwd, job, request);
  if (!options.wait) {
    outputCommandResult(payload, renderQueuedTaskLaunch(payload), options.json);
    return;
  }
  if (!options.json) process.stderr.write(`[codex] Waiting for ${job.id}. The job continues if this caller exits.\n`);
  const snapshot = await waitForSingleJobSnapshot(cwd, job.id, {
    timeoutMs: request.jobTimeoutMs + 15000,
    pollIntervalMs: 200
  });
  if (snapshot.waitTimedOut) {
    outputCommandResult({ ...payload, ...snapshot }, `${renderQueuedTaskLaunch(payload)}Waiting ended while the job was still active.\n`, options.json);
    process.exitCode = 1;
    return;
  }
  const stored = readStoredJob(job.workspaceRoot, job.id);
  const result = stored?.result ?? { status: 1, error: { message: stored?.errorMessage ?? "Codex job failed before producing a result." } };
  outputCommandResult(result, renderStoredJobResult(stored ?? job, stored), options.json);
  if (stored?.status !== "completed") process.exitCode = 1;
}

function spawnDetachedTaskWorker(cwd, jobId) {
  const scriptPath = path.join(ROOT_DIR, "scripts", "codex-companion.mjs");
  const child = spawn(process.execPath, [scriptPath, "task-worker", "--cwd", cwd, "--job-id", jobId], {
    cwd,
    env: process.env,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
  return child;
}

function enqueueBackgroundTask(cwd, job, request) {
  const { logFile } = createTrackedProgress(job);
  appendLogLine(logFile, "Queued for background execution.");

  const queuedRecord = {
    ...job,
    status: "queued",
    phase: "queued",
    pid: null,
    detached: true,
    dispatchPid: process.pid,
    cancelViaState: true,
    logFile,
    request
  };
  writeJobFile(job.workspaceRoot, job.id, queuedRecord);
  upsertJob(job.workspaceRoot, queuedRecord);
  // Publish the request before starting the worker; only the worker writes its PID.
  // Updating it here after spawn can overwrite a fast worker's terminal state.
  const child = spawnDetachedTaskWorker(cwd, job.id);
  child.on("error", (error) => {
    const failed = { ...queuedRecord, status: "failed", phase: "failed", errorMessage: error.message, completedAt: nowIso() };
    writeJobFile(job.workspaceRoot, job.id, failed);
    upsertJob(job.workspaceRoot, failed);
  });

  return {
    payload: {
      jobId: job.id,
      status: "queued",
      title: job.title,
      summary: job.summary,
      logFile
    },
    logFile
  };
}

async function handleReviewCommand(argv, config) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["base", "scope", "cwd", "prompt-file", "output-file", ...RUNTIME_VALUE_OPTIONS],
    booleanOptions: ["json", "background", "wait", "headless", "multi-agent"],
    rejectUnknownOptions: true,
    aliasMap: {
      m: "model"
    }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  validateExecutionMode(options);
  const settings = runtimeSettings(options);
  const focusText = options["prompt-file"] ? fs.readFileSync(path.resolve(cwd, options["prompt-file"]), "utf8") : positionals.join(" ").trim();
  const target = resolveReviewTarget(cwd, {
    base: options.base,
    scope: options.scope
  });

  if (!options.headless) config.validateRequest?.(target, focusText);
  const metadata = buildReviewJobMetadata(config.reviewName, target);
  const job = createCompanionJob({
    prefix: "review",
    kind: metadata.kind,
    title: metadata.title,
    workspaceRoot,
    jobClass: "review",
    summary: metadata.summary
  });
  const request = {
    kind: "review", cwd, target,
    settings, focusText,
    headless: Boolean(options.headless),
    outputFile: options["output-file"] ? path.resolve(cwd, options["output-file"]) : null,
    reviewName: config.reviewName,
    jobTimeoutMs: jobTimeout(options)
  };
  await dispatchJob(cwd, job, request, options);
}

async function handleReview(argv) {
  return handleReviewCommand(argv, {
    reviewName: "Review",
    validateRequest: validateNativeReviewRequest
  });
}

async function handleTask(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "prompt-file", "resume", ...RUNTIME_VALUE_OPTIONS],
    booleanOptions: ["json", "write", "resume-last", "fresh", "background", "wait", "multi-agent", "stop-review"],
    rejectUnknownOptions: true,
    aliasMap: {
      m: "model"
    }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  validateExecutionMode(options);
  const settings = runtimeSettings(options);
  const prompt = readTaskPrompt(cwd, options, positionals);

  const resumeLast = Boolean(options["resume-last"]);
  const resumeThreadId = options.resume ?? null;
  const fresh = Boolean(options.fresh);
  if ([resumeLast, Boolean(resumeThreadId), fresh].filter(Boolean).length > 1) {
    throw new Error("Choose only one of --resume <thread-id>, --resume-last, or --fresh.");
  }
  const write = Boolean(options.write);
  const stopReview = Boolean(options["stop-review"]);
  if (stopReview && (write || resumeLast || resumeThreadId)) throw new Error("Stop reviews must be fresh and read-only.");
  const taskMetadata = buildTaskRunMetadata({
    prompt,
    resumeLast: resumeLast || Boolean(resumeThreadId),
    stopReview
  });

  requireTaskRequest(prompt, resumeLast || Boolean(resumeThreadId));
  const job = buildTaskJob(workspaceRoot, taskMetadata, write);
  const request = buildTaskRequest({ cwd, settings, prompt, write, resumeLast, resumeThreadId, jobId: job.id, jobTimeoutMs: jobTimeout(options), stopReview });
  await dispatchJob(cwd, job, request, options);
}

async function handleTransfer(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "source"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const { payload, rendered } = await executeTransfer(cwd, {
    source: options.source
  });
  outputCommandResult(payload, rendered, options.json);
}

async function handleTaskWorker(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "job-id"]
  });

  if (!options["job-id"]) {
    throw new Error("Missing required --job-id for task-worker.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const storedJob = readStoredJob(workspaceRoot, options["job-id"]);
  if (!storedJob) {
    throw new Error(`No stored job found for ${options["job-id"]}.`);
  }

  const request = storedJob.request;
  if (!request || typeof request !== "object") {
    throw new Error(`Stored job ${options["job-id"]} is missing its task request payload.`);
  }
  if (storedJob.status !== "queued") return;
  const controller = new AbortController();
  const abortWorker = () => controller.abort(new Error("Codex worker was interrupted."));
  process.once("SIGTERM", abortWorker);
  process.once("SIGINT", abortWorker);
  const timer = setTimeout(() => controller.abort(new Error(`Codex job exceeded its ${request.jobTimeoutMs ?? DEFAULT_JOB_TIMEOUT_MS} ms deadline.`)), request.jobTimeoutMs ?? DEFAULT_JOB_TIMEOUT_MS);
  const cancellationPoll = setInterval(() => {
    try {
      if (readStoredJob(workspaceRoot, storedJob.id)?.status === "cancelled") {
        controller.abort(new Error("Cancelled by user."));
      }
    } catch (error) {
      controller.abort(error);
    }
  }, 250);
  let workerOwned = false;

  const { logFile, progress } = createTrackedProgress(
    {
      ...storedJob,
      workspaceRoot
    },
    {
      logFile: storedJob.logFile ?? null
    }
  );
  try {
    await runTrackedJob(
    {
      ...storedJob,
      workspaceRoot,
      logFile
    },
    () => {
      workerOwned = true;
      return (request.kind === "review" ? executeReviewRun : executeTaskRun)({
        ...request,
        signal: controller.signal,
        onProgress: progress
      });
    },
    { logFile }
    );
  } finally {
    clearTimeout(timer);
    clearInterval(cancellationPoll);
    process.removeListener("SIGTERM", abortWorker);
    process.removeListener("SIGINT", abortWorker);
    if (workerOwned) upsertJob(workspaceRoot, { id: storedJob.id, workerStoppedAt: nowIso() });
  }
}

async function handleStatus(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms", "poll-interval-ms"],
    booleanOptions: ["json", "all", "wait"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  if (reference) {
    const snapshot = options.wait
      ? await waitForSingleJobSnapshot(cwd, reference, {
          timeoutMs: options["timeout-ms"],
          pollIntervalMs: options["poll-interval-ms"]
        })
      : buildSingleJobSnapshot(cwd, reference);
    outputCommandResult(snapshot, renderJobStatusReport(snapshot.job), options.json);
    return;
  }

  if (options.wait) {
    throw new Error("`status --wait` requires a job id.");
  }

  const report = buildStatusSnapshot(cwd, { all: options.all });
  outputResult(renderStatusPayload(report, options.json), options.json);
}

function handleResult(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveResultJob(cwd, reference);
  const storedJob = readStoredJob(workspaceRoot, job.id);
  const payload = {
    job,
    storedJob
  };

  outputCommandResult(payload, renderStoredJobResult(job, storedJob), options.json);
}

function handleTaskResumeCandidate(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const sessionId = getCurrentClaudeSessionId();
  const jobs = filterJobsForCurrentClaudeSession(sortJobsNewestFirst(listJobs(workspaceRoot)));
  const candidate = findLatestResumableTaskJob(jobs);

  const payload = {
    available: Boolean(candidate),
    sessionId,
    candidate:
      candidate == null
        ? null
        : {
            id: candidate.id,
            status: candidate.status,
            title: candidate.title ?? null,
            summary: candidate.summary ?? null,
            threadId: candidate.threadId,
            completedAt: candidate.completedAt ?? null,
            updatedAt: candidate.updatedAt ?? null
          }
  };

  const rendered = candidate
    ? `Resumable task found: ${candidate.id} (${candidate.status}).\n`
    : "No resumable task found for this session.\n";
  outputCommandResult(payload, rendered, options.json);
}

async function handleCancel(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveCancelableJob(cwd, reference, { env: process.env });
  // The same per-job lock protects worker claims. Cancel-first blocks the
  // runner; claim-first lets the owned worker observe the cancellation record.
  const cancelled = cancelJob(workspaceRoot, job.id);
  const previous = cancelled.previous ?? job;
  const nextJob = cancelled.job ?? job;
  if (!cancelled.changed) {
    outputCommandResult({ jobId: job.id, status: nextJob.status, title: nextJob.title }, `Job ${job.id} is already ${nextJob.status}.\n`, options.json);
    return;
  }
  const threadId = previous.threadId ?? null;
  const turnId = previous.turnId ?? null;
  // Current workers observe the cancelled record and interrupt their own app-server.
  // No numeric PID is used as permission to signal an unrelated OS process. Legacy
  // records without a live worker can still have a turn in a shared broker.
  const interrupt = previous.cancelViaState
    ? { attempted: false, interrupted: false }
    : await interruptAppServerTurn(previous.request?.cwd ?? workspaceRoot, { threadId, turnId });
  let workerStopped = !previous.pid;
  if (previous.cancelViaState && previous.pid) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (readStoredJob(workspaceRoot, job.id)?.workerStoppedAt) {
        workerStopped = true;
        break;
      }
      await sleep(100);
    }
  }
  if (interrupt.attempted) {
    appendLogLine(
      job.logFile,
      interrupt.interrupted
        ? `Requested Codex turn interrupt for ${turnId} on ${threadId}.`
        : `Codex turn interrupt failed${interrupt.detail ? `: ${interrupt.detail}` : "."}`
    );
  }

  appendLogLine(job.logFile, "Cancelled by user.");

  const payload = {
    jobId: job.id,
    status: "cancelled",
    title: job.title,
    cancellationRequested: true,
    workerStopped,
    turnInterruptAttempted: interrupt.attempted,
    turnInterrupted: interrupt.interrupted
  };

  outputCommandResult(payload, renderCancelReport(nextJob), options.json);
}

async function main() {
  const [subcommand, ...rawArgv] = process.argv.slice(2);
  const argv = readInvocationArgs(rawArgv);
  const optionEnd = argv.indexOf("--");
  const optionArgs = optionEnd < 0 ? argv : argv.slice(0, optionEnd);
  if (!subcommand || subcommand === "help" || subcommand === "--help" || subcommand === "-h" || optionArgs.some(arg => arg === "--help" || arg === "-h")) {
    printUsage();
    return;
  }

  switch (subcommand) {
    case "setup":
      await handleSetup(argv);
      break;
    case "review":
      await handleReview(argv);
      break;
    case "adversarial-review":
      await handleReviewCommand(argv, {
        reviewName: "Adversarial Review"
      });
      break;
    case "task":
      await handleTask(argv);
      break;
    case "transfer":
      await handleTransfer(argv);
      break;
    case "task-worker":
      await handleTaskWorker(argv);
      break;
    case "status":
      await handleStatus(argv);
      break;
    case "result":
      handleResult(argv);
      break;
    case "task-resume-candidate":
      handleTaskResumeCandidate(argv);
      break;
    case "cancel":
      await handleCancel(argv);
      break;
    default:
      throw new Error(`Unknown subcommand: ${subcommand}`);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
