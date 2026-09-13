import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { getSessionRuntimeStatus } from "./codex.mjs";
import { getConfig, listJobs, readJobFile, resolveJobFile, resolveStateDir, upsertJob, writeJobFile } from "./state.mjs";
import { SESSION_ID_ENV } from "./tracked-jobs.mjs";
import { readProcessIdentity } from "./worker-identity.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

export const DEFAULT_MAX_STATUS_JOBS = 8;
export const DEFAULT_MAX_PROGRESS_LINES = 4;
const QUEUED_DISPATCH_GRACE_MS = 60 * 1000;
const QUEUED_NO_PID_MAX_AGE_MS = 5 * 60 * 1000;

export function sortJobsNewestFirst(jobs) {
  return [...jobs].sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")));
}

function getCurrentSessionId(options = {}) {
  return options.env?.[SESSION_ID_ENV] ?? process.env[SESSION_ID_ENV] ?? null;
}

function filterJobsForCurrentSession(jobs, options = {}) {
  const sessionId = getCurrentSessionId(options);
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

function getJobTypeLabel(job) {
  if (typeof job.kindLabel === "string" && job.kindLabel) {
    return job.kindLabel;
  }
  if (job.kind === "adversarial-review") {
    return "adversarial-review";
  }
  if (job.jobClass === "review") {
    return "review";
  }
  if (job.jobClass === "task") {
    return "rescue";
  }
  if (job.kind === "review") {
    return "review";
  }
  if (job.kind === "task") {
    return "rescue";
  }
  return "job";
}

function stripLogPrefix(line) {
  return line.replace(/^\[[^\]]+\]\s*/, "").trim();
}

function isProgressBlockTitle(line) {
  return (
    ["Final output", "Assistant message", "Reasoning summary", "Review output"].includes(line) ||
    /^Subagent .+ message$/.test(line) ||
    /^Subagent .+ reasoning summary$/.test(line)
  );
}

export function readJobProgressPreview(logFile, maxLines = DEFAULT_MAX_PROGRESS_LINES) {
  if (!logFile || !fs.existsSync(logFile)) {
    return [];
  }

  const lines = fs
    .readFileSync(logFile, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .filter((line) => line.startsWith("["))
    .map(stripLogPrefix)
    .filter((line) => line && !isProgressBlockTitle(line));

  return lines.slice(-maxLines);
}

function formatElapsedDuration(startValue, endValue = null) {
  const start = Date.parse(startValue ?? "");
  if (!Number.isFinite(start)) {
    return null;
  }

  const end = endValue ? Date.parse(endValue) : Date.now();
  if (!Number.isFinite(end) || end < start) {
    return null;
  }

  const totalSeconds = Math.max(0, Math.round((end - start) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

function looksLikeVerificationCommand(line) {
  return /\b(test|tests|lint|build|typecheck|type-check|check|verify|validate|pytest|jest|vitest|cargo test|npm test|pnpm test|yarn test|go test|mvn test|gradle test|tsc|eslint|ruff)\b/i.test(
    line
  );
}

function inferLegacyJobPhase(job, progressPreview = []) {
  switch (job.status) {
    case "queued":
      return "queued";
    case "cancelled":
      return "cancelled";
    case "failed":
      return "failed";
    case "completed":
      return "done";
    default:
      break;
  }

  for (let index = progressPreview.length - 1; index >= 0; index -= 1) {
    const line = progressPreview[index].toLowerCase();
    if (line.startsWith("starting codex") || line.startsWith("thread ready") || line.startsWith("turn started")) {
      return "starting";
    }
    if (line.startsWith("reviewer started") || line.includes("review mode")) {
      return "reviewing";
    }
    if (line.startsWith("searching:") || line.startsWith("calling ") || line.startsWith("running tool:")) {
      return "investigating";
    }
    if (line.startsWith("starting collaboration tool:")) {
      return "investigating";
    }
    if (line.startsWith("running command:")) {
      return looksLikeVerificationCommand(line)
        ? "verifying"
        : job.jobClass === "review"
          ? "reviewing"
          : "investigating";
    }
    if (line.startsWith("command completed:")) {
      return looksLikeVerificationCommand(line) ? "verifying" : "running";
    }
    if (line.startsWith("applying ") || line.startsWith("file changes ")) {
      return "editing";
    }
    if (line.startsWith("turn completed")) {
      return "finalizing";
    }
    if (line.startsWith("codex error:") || line.startsWith("failed:")) {
      return "failed";
    }
  }

  return job.jobClass === "review" ? "reviewing" : "running";
}

function requestedRuntimeForJob(job) {
  const settings = job.request?.settings;
  if (!settings || typeof settings !== "object" || job.runtime) {
    return null;
  }
  return {
    source: "requested",
    model: null,
    reasoningEffort: null,
    contextWindow: null,
    configuredModel: settings.model ?? null,
    configuredReasoningEffort: settings.effort ?? null,
    configuredContextWindow: settings.contextWindow ?? null
  };
}

export function enrichJob(job, options = {}) {
  const maxProgressLines = options.maxProgressLines ?? DEFAULT_MAX_PROGRESS_LINES;
  const { request: _request, result: _result, rendered: _rendered, ...publicJob } = job;
  const requestedRuntime = requestedRuntimeForJob(job);
  const enriched = {
    ...publicJob,
    ...(requestedRuntime ? { runtime: requestedRuntime } : {}),
    kindLabel: getJobTypeLabel(job),
    progressPreview:
      job.status === "queued" || job.status === "running" || job.status === "failed"
        ? readJobProgressPreview(job.logFile, maxProgressLines)
        : [],
    elapsed: formatElapsedDuration(job.startedAt ?? job.createdAt, job.completedAt ?? null),
    duration:
      job.status === "completed" || job.status === "failed" || job.status === "cancelled"
        ? formatElapsedDuration(job.startedAt ?? job.createdAt, job.completedAt ?? job.updatedAt)
        : null
  };

  return {
    ...enriched,
    phase: enriched.phase ?? inferLegacyJobPhase(enriched, enriched.progressPreview)
  };
}

export function readStoredJob(workspaceRoot, jobId) {
  const jobFile = resolveJobFile(workspaceRoot, jobId);
  const stateRoot = path.dirname(resolveStateDir(workspaceRoot));
  const candidateFiles = new Set([jobFile]);
  if (fs.existsSync(stateRoot)) {
    for (const entry of fs.readdirSync(stateRoot, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        candidateFiles.add(path.join(stateRoot, entry.name, "jobs", `${jobId}.json`));
      }
    }
  }
  const matches = [];
  for (const candidate of candidateFiles) {
    if (!fs.existsSync(candidate)) {
      continue;
    }
    try {
      matches.push(readJobFile(candidate));
    } catch {
      // Ignore a malformed sibling record and keep searching for an exact id.
    }
  }
  return matches.length === 1 ? matches[0] : null;
}

function processState(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return "unknown";
  }
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    return error?.code === "ESRCH" ? "dead" : "unknown";
  }
}

function isDefinitivelyDead(pid) {
  return processState(pid) === "dead";
}

function hasWorkerIdentity(identity) {
  return Boolean(
    identity &&
      typeof identity.bootId === "string" &&
      identity.bootId &&
      typeof identity.startTime === "string" &&
      identity.startTime
  );
}

function workerRecoveryState(job) {
  if (!Number.isInteger(job.pid) || job.pid <= 0) {
    return { dead: false, reason: null };
  }

  if (hasWorkerIdentity(job.workerIdentity)) {
    const currentIdentity = readProcessIdentity(job.pid);
    if (currentIdentity) {
      const replaced =
        currentIdentity.bootId !== job.workerIdentity.bootId || currentIdentity.startTime !== job.workerIdentity.startTime;
      return { dead: replaced, reason: replaced ? "replaced" : null };
    }
  }

  // A PID check is a safe fallback only for records that explicitly use
  // state-based cancellation. Legacy records must not kill a reused PID.
  return job.cancelViaState === true && processState(job.pid) === "dead"
    ? { dead: true, reason: "dead" }
    : { dead: false, reason: null };
}

function jobAgeMs(job, now = Date.now()) {
  const timestamp = Date.parse(job.createdAt ?? job.updatedAt ?? "");
  return Number.isFinite(timestamp) ? Math.max(0, now - timestamp) : 0;
}

function shouldRecoverQueuedJob(job, now = Date.now()) {
  if (job.status !== "queued" || Number.isInteger(job.pid)) {
    return false;
  }
  const age = jobAgeMs(job, now);
  if (Number.isInteger(job.dispatchPid) && isDefinitivelyDead(job.dispatchPid)) {
    return age >= QUEUED_DISPATCH_GRACE_MS;
  }
  return !Number.isInteger(job.dispatchPid) && age >= QUEUED_NO_PID_MAX_AGE_MS;
}

function recoverInterruptedJobs(jobs, defaultWorkspaceRoot = null) {
  const now = Date.now();
  return jobs.map((job) => {
    const workerRecovery =
      job.status === "running" || (job.status === "queued" && Number.isInteger(job.pid))
        ? workerRecoveryState(job)
        : { dead: false, reason: null };
    if (!workerRecovery.dead && !shouldRecoverQueuedJob(job, now)) {
      return job;
    }
    const completedAt = new Date().toISOString();
    const errorMessage = workerRecovery.reason === "replaced"
      ? `Background worker process ${job.pid} was replaced by another process; the job was interrupted before completion. Start the job again.`
      : workerRecovery.dead
        ? `Background worker process ${job.pid} is no longer running; the job was interrupted before completion. Start the job again.`
      : `Background worker did not start after dispatch; the queued job was interrupted before completion. Start the job again.`;
    const recovered = {
      ...job,
      status: "failed",
      phase: "failed",
      pid: null,
      dispatchPid: null,
      completedAt,
      errorMessage
    };
    const workspaceRoot = job.workspaceRoot ?? defaultWorkspaceRoot;
    if (!workspaceRoot) {
      return job;
    }
    writeJobFile(workspaceRoot, job.id, recovered);
    upsertJob(workspaceRoot, recovered);
    return recovered;
  });
}

function matchJobReference(jobs, reference, predicate = () => true) {
  const filtered = jobs.filter(predicate);
  if (!reference) {
    return filtered[0] ?? null;
  }

  const exact = filtered.find((job) => job.id === reference);
  if (exact) {
    return exact;
  }

  const prefixMatches = filtered.filter((job) => job.id.startsWith(reference));
  if (prefixMatches.length === 1) {
    return prefixMatches[0];
  }
  if (prefixMatches.length > 1) {
    throw new Error(`Job reference "${reference}" is ambiguous. Use a longer job id.`);
  }

  throw new Error(`No job found for "${reference}". Run /codex:status to list known jobs.`);
}

export function buildStatusSnapshot(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = getConfig(workspaceRoot);
  const jobs = sortJobsNewestFirst(
    filterJobsForCurrentSession(recoverInterruptedJobs(listJobs(workspaceRoot), workspaceRoot), options)
  );
  const maxJobs = options.maxJobs ?? DEFAULT_MAX_STATUS_JOBS;
  const maxProgressLines = options.maxProgressLines ?? DEFAULT_MAX_PROGRESS_LINES;

  const running = jobs
    .filter((job) => job.status === "queued" || job.status === "running")
    .map((job) => enrichJob(job, { maxProgressLines }));

  const latestFinishedRaw = jobs.find((job) => job.status !== "queued" && job.status !== "running") ?? null;
  const latestFinished = latestFinishedRaw ? enrichJob(latestFinishedRaw, { maxProgressLines }) : null;

  const recent = (options.all ? jobs : jobs.slice(0, maxJobs))
    .filter((job) => job.status !== "queued" && job.status !== "running" && job.id !== latestFinished?.id)
    .map((job) => enrichJob(job, { maxProgressLines }));

  return {
    workspaceRoot,
    config,
    sessionRuntime: getSessionRuntimeStatus(options.env, workspaceRoot),
    running,
    latestFinished,
    recent,
    needsReview: Boolean(config.stopReviewGate)
  };
}

export function buildSingleJobSnapshot(cwd, reference, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(recoverInterruptedJobs(listJobs(workspaceRoot), workspaceRoot));
  const exactStored = reference ? readStoredJob(workspaceRoot, reference) : null;
  if (reference && jobs.some((job) => job.id === reference) && !exactStored) {
    throw new Error(`Job reference "${reference}" is ambiguous across workspace state directories.`);
  }
  let selected = exactStored;
  if (!selected) {
    try {
      selected = matchJobReference(jobs, reference);
    } catch {
      selected = null;
    }
  }
  const globalSelected = selected;
  if (!globalSelected) {
    throw new Error(`No job found for "${reference}". Run /codex:status to inspect known jobs.`);
  }

  return {
    workspaceRoot: globalSelected.workspaceRoot ?? workspaceRoot,
    job: enrichJob(globalSelected, { maxProgressLines: options.maxProgressLines })
  };
}

export function resolveResultJob(cwd, reference) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(
    recoverInterruptedJobs(
      reference ? listJobs(workspaceRoot) : filterJobsForCurrentSession(listJobs(workspaceRoot)),
      workspaceRoot
    )
  );
  const exactStored = reference ? readStoredJob(workspaceRoot, reference) : null;
  if (reference && jobs.some((job) => job.id === reference) && !exactStored) {
    throw new Error(`Job reference "${reference}" is ambiguous across workspace state directories.`);
  }
  let selected = null;
  try {
    selected = matchJobReference(
      jobs,
      reference,
      (job) => job.status === "completed" || job.status === "failed" || job.status === "cancelled"
    );
  } catch {
    // An explicit id may belong to another workspace state directory.
  }

  if (selected) {
    return { workspaceRoot, job: selected };
  }

  if (reference) {
    const globalSelected = exactStored;
    if (globalSelected && ["completed", "failed", "cancelled"].includes(globalSelected.status)) {
      return { workspaceRoot: globalSelected.workspaceRoot ?? workspaceRoot, job: globalSelected };
    }
  }

  const active = matchJobReference(jobs, reference, (job) => job.status === "queued" || job.status === "running");
  if (active) {
    throw new Error(`Job ${active.id} is still ${active.status}. Check /codex:status and try again once it finishes.`);
  }

  if (reference) {
    throw new Error(`No finished job found for "${reference}". Run /codex:status to inspect active jobs.`);
  }

  throw new Error("No finished Codex jobs found for this repository yet.");
}

export function resolveCancelableJob(cwd, reference, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot));
  const activeJobs = jobs.filter((job) => job.status === "queued" || job.status === "running");

  if (reference) {
    const exactStored = readStoredJob(workspaceRoot, reference);
    if (jobs.some((job) => job.id === reference) && !exactStored) {
      throw new Error(`Job reference "${reference}" is ambiguous across workspace state directories.`);
    }
    let selected = null;
    try {
      selected = matchJobReference(activeJobs, reference);
    } catch {
      // An explicit id may belong to another workspace state directory.
    }
    if (!selected) {
      const globalSelected = exactStored;
      if (globalSelected && (globalSelected.status === "queued" || globalSelected.status === "running")) {
        return { workspaceRoot: globalSelected.workspaceRoot ?? workspaceRoot, job: globalSelected };
      }
      throw new Error(`No active job found for "${reference}".`);
    }
    return { workspaceRoot, job: selected };
  }

  const sessionScopedActiveJobs = filterJobsForCurrentSession(activeJobs, options);

  if (sessionScopedActiveJobs.length === 1) {
    return { workspaceRoot, job: sessionScopedActiveJobs[0] };
  }
  if (sessionScopedActiveJobs.length > 1) {
    throw new Error("Multiple Codex jobs are active. Pass a job id to /codex:cancel.");
  }

  if (getCurrentSessionId(options)) {
    throw new Error("No active Codex jobs to cancel for this session.");
  }

  throw new Error("No active Codex jobs to cancel.");
}
