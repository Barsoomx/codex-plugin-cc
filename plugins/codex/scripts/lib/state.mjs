import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { readProcessIdentity } from "./worker-identity.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

const STATE_VERSION = 1;
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const FALLBACK_STATE_ROOT_DIR = path.join(os.tmpdir(), "codex-companion");
const STATE_FILE_NAME = "state.json";
const CONFIG_FILE_NAME = "config.json";
const JOBS_DIR_NAME = "jobs";
const MAX_JOBS = 50;
const JOB_LOCK_TIMEOUT_MS = 2000;
const JOB_LOCK_POLL_MS = 10;
const JOB_LOCK_WAIT_CELL = new Int32Array(new SharedArrayBuffer(4));

function nowIso() {
  return new Date().toISOString();
}

function lockFilePath(cwd, jobId) {
  return path.join(resolveJobsDir(cwd), `${jobId}.lock`);
}

function readLockOwner(lockPath) {
  try {
    const owner = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    return Number.isInteger(owner?.pid) && owner.pid > 0 ? owner : null;
  } catch {
    return null;
  }
}

function isDefinitivelyDead(owner) {
  if (!owner) {
    return false;
  }
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (error) {
    return error?.code === "ESRCH";
  }
}

function acquireJobLock(cwd, jobId) {
  ensureStateDir(cwd);
  const lockPath = lockFilePath(cwd, jobId);
  const token = randomUUID();
  const deadline = Date.now() + JOB_LOCK_TIMEOUT_MS;

  while (true) {
    let descriptor = null;
    try {
      descriptor = fs.openSync(lockPath, "wx", 0o600);
      fs.writeSync(descriptor, JSON.stringify({ pid: process.pid, token, createdAt: nowIso() }), null, "utf8");
      fs.closeSync(descriptor);
      return { lockPath, token };
    } catch (error) {
      if (descriptor !== null) {
        try {
          fs.closeSync(descriptor);
        } catch {
          // The descriptor is best-effort cleanup after a failed acquisition.
        }
      }
      if (error?.code !== "EEXIST") {
        throw error;
      }
    }

    const owner = readLockOwner(lockPath);
    if (isDefinitivelyDead(owner)) {
      try {
        fs.unlinkSync(lockPath);
      } catch (error) {
        if (error?.code !== "ENOENT") {
          throw error;
        }
      }
      continue;
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(`Timed out waiting for job lock: ${jobId}`);
    }
    Atomics.wait(JOB_LOCK_WAIT_CELL, 0, 0, Math.min(JOB_LOCK_POLL_MS, remaining));
  }
}

function releaseJobLock(lock) {
  try {
    const owner = readLockOwner(lock.lockPath);
    if (owner?.token === lock.token) {
      fs.unlinkSync(lock.lockPath);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}

function withJobLock(cwd, jobId, callback) {
  const lock = acquireJobLock(cwd, jobId);
  try {
    return callback();
  } finally {
    releaseJobLock(lock);
  }
}

function defaultState() {
  return {
    version: STATE_VERSION,
    config: {
      stopReviewGate: false
    },
    jobs: []
  };
}

export function resolveStateDir(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let canonicalWorkspaceRoot = workspaceRoot;
  try {
    canonicalWorkspaceRoot = fs.realpathSync.native(workspaceRoot);
  } catch {
    canonicalWorkspaceRoot = workspaceRoot;
  }

  const slugSource = path.basename(workspaceRoot) || "workspace";
  const slug = slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonicalWorkspaceRoot).digest("hex").slice(0, 16);
  const pluginDataDir = process.env[PLUGIN_DATA_ENV];
  const stateRoot = pluginDataDir ? path.join(pluginDataDir, "state") : FALLBACK_STATE_ROOT_DIR;
  return path.join(stateRoot, `${slug}-${hash}`);
}

export function resolveStateFile(cwd) {
  return path.join(resolveStateDir(cwd), STATE_FILE_NAME);
}

export function resolveConfigFile(cwd) {
  return path.join(resolveStateDir(cwd), CONFIG_FILE_NAME);
}

export function resolveJobsDir(cwd) {
  return path.join(resolveStateDir(cwd), JOBS_DIR_NAME);
}

export function ensureStateDir(cwd) {
  fs.mkdirSync(resolveJobsDir(cwd), { recursive: true });
}

export function loadState(cwd) {
  const stateFile = resolveStateFile(cwd);
  let parsed = {};
  try {
    if (fs.existsSync(stateFile)) {
      parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    }
  } catch {
    parsed = {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    parsed = {};
  }

  let authoritativeConfig = null;
  try {
    const configFile = resolveConfigFile(cwd);
    if (fs.existsSync(configFile)) {
      const candidate = JSON.parse(fs.readFileSync(configFile, "utf8"));
      if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
        authoritativeConfig = candidate;
      }
    }
  } catch {
    authoritativeConfig = null;
  }

  return {
    ...defaultState(),
    ...parsed,
    config: {
      ...defaultState().config,
      ...(parsed.config ?? {}),
      ...(authoritativeConfig ?? {})
    },
    jobs: Array.isArray(parsed.jobs) ? parsed.jobs : []
  };
}

function pruneJobs(jobs) {
  const sorted = [...jobs].sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")));
  const active = sorted.filter((job) => job.status === "queued" || job.status === "running");
  const finished = sorted.filter((job) => job.status !== "queued" && job.status !== "running");
  return [...active, ...finished.slice(0, Math.max(0, MAX_JOBS - active.length))];
}

function removeFileIfExists(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

export function saveState(cwd, state) {
  const previousJobs = listJobs(cwd);
  ensureStateDir(cwd);
  const mergedJobs = new Map(previousJobs.map((job) => [job.id, job]));
  for (const job of state.jobs ?? []) {
    mergedJobs.set(job.id, { ...mergedJobs.get(job.id), ...job });
  }
  const nextJobs = pruneJobs([...mergedJobs.values()]);
  const configFile = resolveConfigFile(cwd);
  let authoritativeConfig = null;
  try {
    if (fs.existsSync(configFile)) {
      const parsedConfig = JSON.parse(fs.readFileSync(configFile, "utf8"));
      if (parsedConfig && typeof parsedConfig === "object" && !Array.isArray(parsedConfig)) {
        authoritativeConfig = parsedConfig;
      }
    }
  } catch {
    authoritativeConfig = null;
  }
  const nextConfig = {
    ...defaultState().config,
    ...(authoritativeConfig ?? state.config ?? {})
  };
  if (!authoritativeConfig) {
    writeConfigFile(cwd, nextConfig);
  }
  const nextState = {
    version: STATE_VERSION,
    config: nextConfig,
    jobs: nextJobs
  };

  const retainedIds = new Set(nextJobs.map((job) => job.id));
  for (const job of previousJobs) {
    if (retainedIds.has(job.id)) {
      continue;
    }
    removeJobFile(resolveJobFile(cwd, job.id));
    removeFileIfExists(job.logFile ?? resolveJobLogFile(cwd, job.id));
  }

  atomicWriteFile(resolveStateFile(cwd), `${JSON.stringify(nextState, null, 2)}\n`);
  return nextState;
}

export function updateState(cwd, mutate) {
  const state = loadState(cwd);
  mutate(state);
  writeConfigFile(cwd, {
    ...defaultState().config,
    ...(state.config ?? {})
  });
  return saveState(cwd, state);
}

export function generateJobId(prefix = "job") {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

function readCurrentJob(cwd, jobId) {
  const jobFile = resolveJobFile(cwd, jobId);
  if (fs.existsSync(jobFile)) {
    return readJobFile(jobFile);
  }
  return loadState(cwd).jobs.find((job) => job?.id === jobId) ?? null;
}

function updateSecondaryIndex(cwd, nextJob) {
  // Keep state.json readable by older plugin versions. Reads use the per-job
  // records, so a concurrent index update cannot lose an otherwise durable job.
  const state = loadState(cwd);
  const previousJobs = listJobs(cwd);
  const mergedJobs = new Map(previousJobs.map((job) => [job.id, job]));
  for (const job of state.jobs ?? []) {
    mergedJobs.set(job.id, { ...mergedJobs.get(job.id), ...job });
  }
  mergedJobs.set(nextJob.id, { ...mergedJobs.get(nextJob.id), ...nextJob });
  const nextJobs = pruneJobs([...mergedJobs.values()]);
  const retainedIds = new Set(nextJobs.map((job) => job.id));
  for (const job of previousJobs) {
    if (retainedIds.has(job.id)) {
      continue;
    }
    removeJobFile(resolveJobFile(cwd, job.id));
    removeFileIfExists(job.logFile ?? resolveJobLogFile(cwd, job.id));
  }
  atomicWriteFile(
    resolveStateFile(cwd),
    `${JSON.stringify({ ...state, version: STATE_VERSION, jobs: nextJobs }, null, 2)}\n`
  );
}

export function upsertJob(cwd, jobPatch) {
  const nextJob = withJobLock(cwd, jobPatch.id, () => {
    const timestamp = nowIso();
    const existing = readCurrentJob(cwd, jobPatch.id);
    const next = {
      ...(existing ?? {}),
      createdAt: existing?.createdAt ?? jobPatch.createdAt ?? timestamp,
      ...jobPatch,
      updatedAt: timestamp
    };

    // A user cancellation is terminal. A late worker completion must not revive it.
    if (jobPatch.status === "cancelled") {
      next.status = "cancelled";
      next.phase = jobPatch.phase ?? "cancelled";
      next.pid = null;
      next.errorMessage = jobPatch.errorMessage ?? existing?.errorMessage ?? "Cancelled by user.";
    } else if (existing?.status === "cancelled") {
      next.status = "cancelled";
      next.phase = existing.phase ?? "cancelled";
      next.pid = null;
      next.errorMessage = existing.errorMessage ?? "Cancelled by user.";
    }

    writeJobFile(cwd, jobPatch.id, next);
    updateSecondaryIndex(cwd, next);
    return next;
  });

  return listJobs(cwd);
}

export function claimQueuedJob(cwd, jobId, pid) {
  return withJobLock(cwd, jobId, () => {
    const existing = readCurrentJob(cwd, jobId);
    if (!existing || existing.status !== "queued") {
      return null;
    }

    const startedAt = nowIso();
    const claimed = {
      ...existing,
      status: "running",
      phase: "starting",
      pid,
      workerIdentity: readProcessIdentity(pid),
      startedAt,
      updatedAt: startedAt
    };
    writeJobFile(cwd, jobId, claimed);
    updateSecondaryIndex(cwd, claimed);
    return claimed;
  });
}

export function cancelJob(cwd, jobId) {
  return withJobLock(cwd, jobId, () => {
    const previous = readCurrentJob(cwd, jobId);
    if (!previous) {
      return { previous: null, job: null, changed: false };
    }
    if (previous.status !== "queued" && previous.status !== "running") {
      return { previous, job: previous, changed: false };
    }

    const completedAt = nowIso();
    const job = {
      ...previous,
      status: "cancelled",
      phase: "cancelled",
      pid: null,
      errorMessage: "Cancelled by user.",
      completedAt,
      cancelledAt: completedAt,
      updatedAt: completedAt
    };
    writeJobFile(cwd, jobId, job);
    updateSecondaryIndex(cwd, job);
    return { previous, job, changed: true };
  });
}

export function listJobs(cwd) {
  const legacyJobs = loadState(cwd).jobs;
  const authoritativeJobs = new Map();
  const jobsDir = resolveJobsDir(cwd);
  if (fs.existsSync(jobsDir)) {
    for (const name of fs.readdirSync(jobsDir)) {
      if (!name.endsWith(".json") || name === STATE_FILE_NAME) {
        continue;
      }
      try {
        const job = readJobFile(path.join(jobsDir, name));
        if (job?.id) {
          authoritativeJobs.set(job.id, job);
        }
      } catch {
        // A partially written legacy record should not make status unavailable.
      }
    }
  }

  for (const job of legacyJobs) {
    if (job?.id && !authoritativeJobs.has(job.id)) {
      authoritativeJobs.set(job.id, job);
    }
  }
  return [...authoritativeJobs.values()];
}

export function setConfig(cwd, key, value) {
  const config = {
    ...loadState(cwd).config,
    [key]: value
  };
  writeConfigFile(cwd, config);
  return loadState(cwd);
}

export function getConfig(cwd) {
  return loadState(cwd).config;
}

export function writeJobFile(cwd, jobId, payload) {
  ensureStateDir(cwd);
  const jobFile = resolveJobFile(cwd, jobId);
  atomicWriteFile(jobFile, `${JSON.stringify(payload, null, 2)}\n`);
  return jobFile;
}

export function readJobFile(jobFile) {
  return JSON.parse(fs.readFileSync(jobFile, "utf8"));
}

function removeJobFile(jobFile) {
  if (fs.existsSync(jobFile)) {
    fs.unlinkSync(jobFile);
  }
}

export function resolveJobLogFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.log`);
}

export function resolveJobFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.json`);
}

function atomicWriteFile(filePath, content) {
  const tempPath = `${filePath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  fs.writeFileSync(tempPath, content, "utf8");
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      fs.renameSync(tempPath, filePath);
      return;
    } catch (error) {
      if (![
        "EACCES",
        "EBUSY",
        "EPERM"
      ].includes(error?.code) || attempt === 99) {
        throw error;
      }
      Atomics.wait(JOB_LOCK_WAIT_CELL, 0, 0, 5);
    }
  }
}

function writeConfigFile(cwd, config) {
  ensureStateDir(cwd);
  atomicWriteFile(resolveConfigFile(cwd), `${JSON.stringify(config, null, 2)}\n`);
}
