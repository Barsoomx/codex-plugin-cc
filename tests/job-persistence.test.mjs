import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import test from "node:test";

import { makeTempDir } from "./helpers.mjs";
import { buildStatusSnapshot } from "../plugins/codex/scripts/lib/job-control.mjs";
import { renderJobStatusReport } from "../plugins/codex/scripts/lib/render.mjs";
import { runTrackedJob, createJobProgressUpdater } from "../plugins/codex/scripts/lib/tracked-jobs.mjs";
import {
  cancelJob,
  claimQueuedJob,
  listJobs,
  readJobFile,
  resolveJobFile,
  upsertJob
} from "../plugins/codex/scripts/lib/state.mjs";
import { readProcessIdentity } from "../plugins/codex/scripts/lib/worker-identity.mjs";

const stateModuleUrl = pathToFileURL(
  path.resolve("plugins/codex/scripts/lib/state.mjs")
).href;

function withPluginData(pluginDataDir, callback) {
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
  return Promise.resolve()
    .then(callback)
    .finally(() => {
      if (previous == null) {
        delete process.env.CLAUDE_PLUGIN_DATA;
      } else {
        process.env.CLAUDE_PLUGIN_DATA = previous;
      }
    });
}

function concurrentUpsert(moduleUrl, workspaceRoot, pluginDataDir, id) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      `import { parentPort, workerData } from "node:worker_threads";
       const { upsertJob } = await import(workerData.moduleUrl);
       upsertJob(workerData.workspaceRoot, { id: workerData.id, status: "queued", title: workerData.id });
       parentPort.postMessage("done");`,
      {
        eval: true,
        env: { ...process.env, CLAUDE_PLUGIN_DATA: pluginDataDir },
        workerData: { moduleUrl, workspaceRoot, id }
      }
    );
    worker.once("message", () => resolve());
    worker.once("error", reject);
  });
}

test("independent concurrent job upserts remain discoverable from per-job records", async () => {
  const workspaceRoot = makeTempDir();
  const pluginDataDir = makeTempDir();

  await Promise.all([
    concurrentUpsert(stateModuleUrl, workspaceRoot, pluginDataDir, "job-a"),
    concurrentUpsert(stateModuleUrl, workspaceRoot, pluginDataDir, "job-b")
  ]);

  await withPluginData(pluginDataDir, () => {
    assert.deepEqual(
      listJobs(workspaceRoot)
        .map((job) => job.id)
        .sort(),
      ["job-a", "job-b"]
    );
  });
});

test("terminal execution preserves progress and cancellation while storing runtime metadata", async () => {
  const workspaceRoot = makeTempDir();
  const pluginDataDir = makeTempDir();

  await withPluginData(pluginDataDir, async () => {
    const job = { id: "job-progress", workspaceRoot, status: "queued", title: "Progress" };
    upsertJob(workspaceRoot, job);
    const progress = createJobProgressUpdater(workspaceRoot, job.id);

    await runTrackedJob(
      job,
      async () => {
        progress({ phase: "running", threadId: "thread-progress", turnId: "turn-progress", message: "working" });
        upsertJob(workspaceRoot, { id: job.id, status: "cancelled", errorMessage: "Cancelled by user." });
        return {
          exitStatus: 0,
          payload: { rawOutput: "late result", runtime: { model: "gpt-test", effort: "high", context: 1234 } },
          rendered: "late result\n"
        };
      },
      {}
    );

    const stored = readJobFile(resolveJobFile(workspaceRoot, job.id));
    assert.equal(stored.status, "cancelled");
    assert.equal(stored.threadId, "thread-progress");
    assert.equal(stored.turnId, "turn-progress");
    assert.deepEqual(stored.runtime, { model: "gpt-test", effort: "high", context: 1234 });

    const report = buildStatusSnapshot(workspaceRoot);
    assert.equal(report.latestFinished.status, "cancelled");
    assert.match(renderJobStatusReport(report.latestFinished), /Runtime: model=gpt-test, effort=high, context=1234/);
  });
});

test("cancellation before claim prevents the worker runner from starting", async () => {
  const workspaceRoot = makeTempDir();
  const pluginDataDir = makeTempDir();

  await withPluginData(pluginDataDir, async () => {
    const job = { id: "job-cancel-before-claim", workspaceRoot, status: "queued", title: "Cancelled" };
    upsertJob(workspaceRoot, job);
    const cancelled = cancelJob(workspaceRoot, job.id);
    let runnerCalled = false;

    const result = await runTrackedJob(job, async () => {
      runnerCalled = true;
      return { exitStatus: 0 };
    });

    assert.equal(cancelled.changed, true);
    assert.equal(result, null);
    assert.equal(runnerCalled, false);
    assert.equal(readJobFile(resolveJobFile(workspaceRoot, job.id)).status, "cancelled");
  });
});

test("only the first worker can claim a queued job", async () => {
  const workspaceRoot = makeTempDir();
  const pluginDataDir = makeTempDir();

  await withPluginData(pluginDataDir, () => {
    const job = { id: "job-single-claim", workspaceRoot, status: "queued", title: "Single claim" };
    upsertJob(workspaceRoot, job);

    const first = claimQueuedJob(workspaceRoot, job.id, process.pid);
    const second = claimQueuedJob(workspaceRoot, job.id, 41002);

    assert.equal(first.status, "running");
    assert.equal(first.pid, process.pid);
    assert.deepEqual(first.workerIdentity, readProcessIdentity(process.pid));
    assert.equal(second, null);
    assert.equal(readJobFile(resolveJobFile(workspaceRoot, job.id)).pid, process.pid);
  });
});

test("cancellation atomically returns and clears the claimed worker pid", async () => {
  const workspaceRoot = makeTempDir();
  const pluginDataDir = makeTempDir();

  await withPluginData(pluginDataDir, () => {
    const job = {
      id: "job-cancel-claimed",
      workspaceRoot,
      status: "queued",
      title: "Claimed",
      threadId: "thread-claimed"
    };
    upsertJob(workspaceRoot, job);
    claimQueuedJob(workspaceRoot, job.id, 41003);

    const cancelled = cancelJob(workspaceRoot, job.id);

    assert.equal(cancelled.changed, true);
    assert.equal(cancelled.previous.pid, 41003);
    assert.equal(cancelled.previous.threadId, "thread-claimed");
    assert.equal(cancelled.job.status, "cancelled");
    assert.equal(cancelled.job.pid, null);
    assert.equal(readJobFile(resolveJobFile(workspaceRoot, job.id)).pid, null);
  });
});

test("late progress cannot revive a cancelled job", async () => {
  const workspaceRoot = makeTempDir();
  const pluginDataDir = makeTempDir();

  await withPluginData(pluginDataDir, () => {
    const job = { id: "job-late-progress", workspaceRoot, status: "queued", title: "Late progress" };
    upsertJob(workspaceRoot, job);
    claimQueuedJob(workspaceRoot, job.id, 41004);
    cancelJob(workspaceRoot, job.id);

    createJobProgressUpdater(workspaceRoot, job.id)({
      phase: "running",
      threadId: "late-thread",
      turnId: "late-turn",
      runtime: { model: "late-model" }
    });
    upsertJob(workspaceRoot, { id: job.id, status: "running", pid: 41004, phase: "running" });

    const stored = readJobFile(resolveJobFile(workspaceRoot, job.id));
    assert.equal(stored.status, "cancelled");
    assert.equal(stored.phase, "cancelled");
    assert.equal(stored.pid, null);
    assert.equal(stored.threadId, "late-thread");
  });
});

test("failed execution exposes the API error in status JSON", async () => {
  const workspaceRoot = makeTempDir();
  const pluginDataDir = makeTempDir();

  await withPluginData(pluginDataDir, async () => {
    const job = { id: "job-api-error", workspaceRoot, status: "queued", title: "API failure" };
    upsertJob(workspaceRoot, job);

    await runTrackedJob(
      job,
      async () => ({
        exitStatus: 1,
        payload: { error: { message: "app-server rate limit exceeded" } },
        rendered: "app-server rate limit exceeded\n"
      }),
      {}
    );

    const report = buildStatusSnapshot(workspaceRoot);
    assert.equal(report.latestFinished.status, "failed");
    assert.equal(report.latestFinished.errorMessage, "app-server rate limit exceeded");
  });
});

test("status snapshots keep large request and result payloads behind /result", async () => {
  const workspaceRoot = makeTempDir();
  const pluginDataDir = makeTempDir();

  await withPluginData(pluginDataDir, () => {
    upsertJob(workspaceRoot, {
      id: "job-private-payload",
      workspaceRoot,
      status: "completed",
      runtime: { model: "gpt-test", reasoningEffort: "high", contextWindow: 1234 },
      request: { prompt: "large request" },
      result: { rawOutput: "large result" },
      rendered: "large result\n"
    });

    const job = buildStatusSnapshot(workspaceRoot).latestFinished;
    assert.equal(Object.hasOwn(job, "request"), false);
    assert.equal(Object.hasOwn(job, "result"), false);
    assert.equal(Object.hasOwn(job, "rendered"), false);
    assert.deepEqual(job.runtime, { model: "gpt-test", reasoningEffort: "high", contextWindow: 1234 });
  });
});

test("status reconciles an old queued record with no worker pid, but honors launch grace", async () => {
  const workspaceRoot = makeTempDir();
  const pluginDataDir = makeTempDir();
  const oldCreatedAt = new Date(Date.now() - 6 * 60 * 1000).toISOString();

  await withPluginData(pluginDataDir, () => {
    upsertJob(workspaceRoot, {
      id: "job-never-started",
      workspaceRoot,
      status: "queued",
      phase: "queued",
      pid: null,
      createdAt: oldCreatedAt
    });
    upsertJob(workspaceRoot, {
      id: "job-launch-window",
      workspaceRoot,
      status: "queued",
      phase: "queued",
      pid: null,
      dispatchPid: process.pid,
      createdAt: new Date().toISOString()
    });

    const report = buildStatusSnapshot(workspaceRoot);
    const recovered = report.latestFinished;
    assert.equal(recovered.id, "job-never-started");
    assert.equal(recovered.status, "failed");
    assert.match(recovered.errorMessage, /did not start|interrupted/i);
    assert.equal(report.running.some((job) => job.id === "job-launch-window"), true);
  });
});

test(
  "status rejects a PID-reused worker identity without signalling the replacement",
  { skip: process.platform !== "linux" },
  async () => {
    const workspaceRoot = makeTempDir();
    const pluginDataDir = makeTempDir();
    const replacement = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore"
    });

    try {
      let replacementIdentity = null;
      for (let attempt = 0; attempt < 20 && !replacementIdentity; attempt += 1) {
        replacementIdentity = readProcessIdentity(replacement.pid);
        if (!replacementIdentity) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      assert.ok(replacementIdentity);

      await withPluginData(pluginDataDir, () => {
        upsertJob(workspaceRoot, {
          id: "job-reused-pid",
          workspaceRoot,
          status: "running",
          phase: "running",
          pid: replacement.pid,
          cancelViaState: true,
          workerIdentity: {
            bootId: replacementIdentity.bootId,
            startTime: `${replacementIdentity.startTime}-previous-worker`
          }
        });

        const report = buildStatusSnapshot(workspaceRoot);
        assert.equal(report.latestFinished.status, "failed");
        assert.match(report.latestFinished.errorMessage, /replaced|interrupted/i);
        assert.doesNotThrow(() => process.kill(replacement.pid, 0));
      });
    } finally {
      replacement.kill();
    }
  }
);
