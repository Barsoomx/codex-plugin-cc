import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { makeTempDir, run } from "./helpers.mjs";
import { getSessionRuntimeStatus } from "../plugins/codex/scripts/lib/codex.mjs";
import {
  DEFAULT_AGENT_TIMEOUT_SECONDS,
  DEFAULT_ASTRA_AUTO_COMPACT_TOKEN_LIMIT,
  DEFAULT_ASTRA_CONTEXT_WINDOW,
  DEFAULT_ASTRA_EFFORT,
  DEFAULT_MODEL,
  DEFAULT_TURN_TIMEOUT_MS,
  resolveRuntimeSettings
} from "../plugins/codex/scripts/lib/runtime-settings.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CODEX_MODULE = path.join(ROOT, "plugins", "codex", "scripts", "lib", "codex.mjs");
const CODEX_MODULE_URL = pathToFileURL(CODEX_MODULE).href;

function installInstrumentedFakeCodex(binDir, behavior = "review-ok") {
  installFakeCodex(binDir, behavior);
  const scriptPath = path.join(binDir, "codex");
  let source = fs.readFileSync(scriptPath, "utf8");

  source = source.replace(
    /(  const state = loadState\(\);\r?\n)(\r?\n  try \{)/,
    `$1  state.requests = state.requests || [];\n  state.requests.push(JSON.parse(JSON.stringify(message)));\n  saveState(state);\n$2`
  );
  source = source.replaceAll(
    "reasoningEffort: null",
    "reasoningEffort: message.params.config?.model_reasoning_effort ?? null"
  );

  if (!source.includes('case "thread/read"')) {
    const resumeCase = source.indexOf('case "thread/resume": {');
    assert.notEqual(resumeCase, -1);
    const threadReadCase = `case "thread/read": {
        const thread = ensureThread(state, message.params.threadId);
        send({ id: message.id, result: { thread: buildThread(thread) } });
        break;
      }

      `;
    source = `${source.slice(0, resumeCase)}${threadReadCase}${source.slice(resumeCase)}`;
  }

  const turnCase = source.indexOf('case "turn/start": {');
  assert.notEqual(turnCase, -1);
  const ensureThread = source.indexOf(
    "const thread = ensureThread(state, message.params.threadId);",
    turnCase
  );
  assert.notEqual(ensureThread, -1);
  const specialBehavior = `
        if (["terminal-error", "retryable-error", "transport-close", "no-completion"].includes(BEHAVIOR)) {
          const turnId = nextTurnId(state);
          send({ id: message.id, result: { turn: buildTurn(turnId) } });
          send({ method: "turn/started", params: { threadId: message.params.threadId, turn: buildTurn(turnId) } });
          if (BEHAVIOR === "terminal-error") {
            send({ method: "error", params: { threadId: message.params.threadId, turnId, willRetry: false, error: { message: "model is not supported for this account" } } });
          } else if (BEHAVIOR === "retryable-error") {
            send({ method: "error", params: { threadId: message.params.threadId, turnId, willRetry: true, error: { message: "stream disconnected" } } });
            emitTurnCompleted(message.params.threadId, turnId, { completed: { type: "agentMessage", id: "msg_" + turnId, text: "Recovered after retry.", phase: "final_answer" } });
          } else if (BEHAVIOR === "transport-close") {
            setImmediate(() => process.exit(0));
          }
          break;
        }
        `;
  source = `${source.slice(0, ensureThread)}${specialBehavior}${source.slice(ensureThread)}`;

  const payloadMarker = source.indexOf("const payload = message.params.outputSchema", turnCase);
  assert.notEqual(payloadMarker, -1);
  const tokenUsageNotification = `
        send({ method: "thread/tokenUsage/updated", params: {
          threadId: message.params.threadId,
          turnId,
          tokenUsage: {
            total: { totalTokens: 42000, inputTokens: 40000, cachedInputTokens: 32000, outputTokens: 2000, reasoningOutputTokens: 500 },
            last: { totalTokens: 1200, inputTokens: 1000, cachedInputTokens: 800, outputTokens: 200, reasoningOutputTokens: 50 },
            modelContextWindow: 828400
          }
        } });
        `;
  source = `${source.slice(0, payloadMarker)}${tokenUsageNotification}${source.slice(payloadMarker)}`;
  fs.writeFileSync(scriptPath, source, "utf8");
}

function invokeTurn(binDir, cwd, options, abortAfterMs = null) {
  const source = `
    import { runAppServerTurn } from ${JSON.stringify(CODEX_MODULE_URL)};
    const controller = new AbortController();
    ${abortAfterMs === null ? "" : `setTimeout(() => controller.abort(new Error("job watchdog expired")), ${abortAfterMs});`}
    try {
      const result = await runAppServerTurn(${JSON.stringify(cwd)}, {
        ...${JSON.stringify(options)},
        ${abortAfterMs === null ? "" : "signal: controller.signal,"}
      });
      console.log(JSON.stringify({ ok: true, result }));
    } catch (error) {
      console.log(JSON.stringify({ ok: false, error: { name: error.name, message: error.message, code: error.code ?? null, timeoutMs: error.timeoutMs ?? null } }));
    }
  `;
  const env = buildEnv(binDir);
  env.CODEX_COMPANION_CODEX_BIN = path.join(
    binDir,
    process.platform === "win32" ? "codex.cmd" : "codex"
  );
  const result = run(process.execPath, ["--input-type=module", "--eval", source], {
    cwd,
    env
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim());
}

test("Astra defaults are explicit and bounded", () => {
  assert.deepEqual(resolveRuntimeSettings({ env: {} }), {
    model: DEFAULT_MODEL,
    effort: DEFAULT_ASTRA_EFFORT,
    contextWindow: DEFAULT_ASTRA_CONTEXT_WINDOW,
    autoCompactTokenLimit: DEFAULT_ASTRA_AUTO_COMPACT_TOKEN_LIMIT,
    turnTimeoutMs: DEFAULT_TURN_TIMEOUT_MS,
    agentTimeoutSeconds: DEFAULT_AGENT_TIMEOUT_SECONDS,
    multiAgent: false,
    headless: false
  });
});

test("session runtime reports direct unless broker reuse is explicitly enabled", () => {
  const cwd = makeTempDir();
  assert.deepEqual(
    getSessionRuntimeStatus({ CODEX_COMPANION_APP_SERVER_ENDPOINT: "unix:/tmp/stale.sock" }, cwd),
    {
      mode: "direct",
      label: "direct per-job process",
      detail: "Each review or task uses its own Codex app-server process and closes it when the run finishes.",
      endpoint: null
    }
  );
  assert.equal(
    getSessionRuntimeStatus(
      {
        CODEX_COMPANION_USE_BROKER: "true",
        CODEX_COMPANION_APP_SERVER_ENDPOINT: "unix:/tmp/explicit.sock"
      },
      cwd
    ).mode,
    "shared"
  );
});

test("model aliases and explicit non-Astra settings preserve their own defaults", () => {
  assert.deepEqual(
    resolveRuntimeSettings({ model: "sol", env: {} }),
    {
      model: "gpt-5.6-sol",
      effort: null,
      contextWindow: null,
      autoCompactTokenLimit: null,
      turnTimeoutMs: DEFAULT_TURN_TIMEOUT_MS,
      agentTimeoutSeconds: DEFAULT_AGENT_TIMEOUT_SECONDS,
      multiAgent: false,
      headless: false
    }
  );
  assert.equal(resolveRuntimeSettings({ model: "astra", env: {} }).model, "gpt-6-astra");
  assert.equal(resolveRuntimeSettings({ model: "spark", env: {} }).model, "gpt-5.3-codex-spark");
  assert.equal(resolveRuntimeSettings({ model: "terra", env: {} }).model, "gpt-5.6-terra");
  assert.equal(resolveRuntimeSettings({ model: "luna", env: {} }).model, "gpt-5.6-luna");
});

test("CLI-style values override environment settings without losing explicit false", () => {
  const settings = resolveRuntimeSettings({
    model: "astra",
    effort: "max",
    contextWindow: "900000",
    autoCompactTokenLimit: "700000",
    turnTimeoutMs: "7200000",
    agentTimeoutSeconds: "7300",
    multiAgent: false,
    headless: true,
    env: {
      CODEX_COMPANION_MODEL: "sol",
      CODEX_COMPANION_EFFORT: "low",
      CODEX_COMPANION_CONTEXT_WINDOW: "500000",
      CODEX_COMPANION_AUTO_COMPACT_TOKEN_LIMIT: "400000",
      CODEX_COMPANION_TURN_TIMEOUT_MS: "60000",
      CODEX_COMPANION_AGENT_TIMEOUT_SECONDS: "120",
      CODEX_COMPANION_MULTI_AGENT: "true"
    }
  });

  assert.deepEqual(settings, {
    model: "gpt-6-astra",
    effort: "max",
    contextWindow: 900000,
    autoCompactTokenLimit: 700000,
    turnTimeoutMs: 7200000,
    agentTimeoutSeconds: 7300,
    multiAgent: false,
    headless: true
  });
});

test("runtime environment variables are honored", () => {
  const settings = resolveRuntimeSettings({
    env: {
      CODEX_COMPANION_MODEL: "luna",
      CODEX_COMPANION_EFFORT: "ultra",
      CODEX_COMPANION_CONTEXT_WINDOW: "600000",
      CODEX_COMPANION_AUTO_COMPACT_TOKEN_LIMIT: "500000",
      CODEX_COMPANION_TURN_TIMEOUT_MS: "3600000",
      CODEX_COMPANION_AGENT_TIMEOUT_SECONDS: "7200",
      CODEX_COMPANION_MULTI_AGENT: "yes"
    }
  });

  assert.deepEqual(settings, {
    model: "gpt-5.6-luna",
    effort: "ultra",
    contextWindow: 600000,
    autoCompactTokenLimit: 500000,
    turnTimeoutMs: 3600000,
    agentTimeoutSeconds: 7200,
    multiAgent: true,
    headless: false
  });
});

test("reasoning effort validation accepts max and ultra but rejects unsupported Astra levels", () => {
  assert.equal(resolveRuntimeSettings({ model: "astra", effort: "max", env: {} }).effort, "max");
  assert.equal(resolveRuntimeSettings({ model: "sol", effort: "ultra", env: {} }).effort, "ultra");
  assert.equal(resolveRuntimeSettings({ model: "sol", effort: "none", env: {} }).effort, "none");
  assert.throws(
    () => resolveRuntimeSettings({ model: "astra", effort: "none", env: {} }),
    /GPT-6 Astra does not support reasoning effort "none"/
  );
  assert.throws(
    () => resolveRuntimeSettings({ model: "astra", effort: "minimal", env: {} }),
    /GPT-6 Astra does not support reasoning effort "minimal"/
  );
  assert.throws(
    () => resolveRuntimeSettings({ effort: "extreme", env: {} }),
    /Unsupported reasoning effort/
  );
});

test("token and timeout bounds fail early", () => {
  for (const value of [0, -1, 1.5, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, "nope"]) {
    assert.throws(
      () => resolveRuntimeSettings({ contextWindow: value, env: {} }),
      /context window must be a finite positive safe integer/
    );
  }
  assert.deepEqual(
    resolveRuntimeSettings({ contextWindow: 800000, env: {} }),
    {
      model: "gpt-6-astra",
      effort: "ultra",
      contextWindow: 800000,
      autoCompactTokenLimit: 720000,
      turnTimeoutMs: DEFAULT_TURN_TIMEOUT_MS,
      agentTimeoutSeconds: DEFAULT_AGENT_TIMEOUT_SECONDS,
      multiAgent: false,
      headless: false
    }
  );
  assert.throws(
    () =>
      resolveRuntimeSettings({
        contextWindow: 800000,
        autoCompactTokenLimit: 800000,
        env: {}
      }),
    /auto-compact token limit must be smaller/
  );
  assert.throws(
    () => resolveRuntimeSettings({ model: "sol", autoCompactTokenLimit: 500000, env: {} }),
    /requires a context window/
  );
  assert.throws(
    () => resolveRuntimeSettings({ turnTimeoutMs: 2_147_483_648, env: {} }),
    /no greater than 2147483647 ms/
  );
  assert.throws(
    () => resolveRuntimeSettings({ multiAgent: "sometimes", env: {} }),
    /must be true or false/
  );
});

test("fresh and resumed turns receive the same runtime config and expose observed metadata", () => {
  const cwd = makeTempDir();
  const binDir = makeTempDir();
  installInstrumentedFakeCodex(binDir);
  const settings = resolveRuntimeSettings({ headless: true, env: {} });

  const fresh = invokeTurn(binDir, cwd, {
    prompt: "review the change",
    persistThread: true,
    reviewOnly: true,
    headless: true,
    settings
  });
  assert.equal(fresh.ok, true, fresh.error?.message);
  assert.equal(fresh.result.status, 0);
  assert.deepEqual(fresh.result.runtime, {
    model: "gpt-6-astra",
    reasoningEffort: "ultra",
    contextWindow: 828400,
    configuredModel: "gpt-6-astra",
    configuredReasoningEffort: "ultra",
    configuredContextWindow: 1000000,
    configuredAutoCompactTokenLimit: 800000,
    turnTimeoutMs: 10800000,
    agentTimeoutSeconds: 9600,
    multiAgent: false,
    headless: true,
    tokenUsage: {
      total: { totalTokens: 42000, inputTokens: 40000, cachedInputTokens: 32000, outputTokens: 2000, reasoningOutputTokens: 500 },
      last: { totalTokens: 1200, inputTokens: 1000, cachedInputTokens: 800, outputTokens: 200, reasoningOutputTokens: 50 },
      modelContextWindow: 828400
    }
  });

  let state = JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
  const start = state.requests.find((request) => request.method === "thread/start");
  const turn = state.requests.find((request) => request.method === "turn/start");
  assert.equal(start.params.model, "gpt-6-astra");
  assert.equal(start.params.sandbox, "read-only");
  assert.equal(start.params.ephemeral, true);
  assert.deepEqual(start.params.config, {
    review_model: "gpt-6-astra",
    features: { multi_agent: false },
    agents: { job_max_runtime_seconds: 9600 },
    model_context_window: 1000000,
    model_auto_compact_token_limit: 800000,
    model_reasoning_effort: "ultra",
    skills: { include_instructions: false }
  });
  assert.match(start.params.developerInstructions, /strictly read-only evidence review/i);
  assert.match(start.params.developerInstructions, /Never run tests, linters, builds/i);
  assert.match(start.params.developerInstructions, /Do not spawn or delegate to subagents/i);
  assert.match(start.params.developerInstructions, /Do not discover, load, or invoke repository or user skills/i);
  assert.equal(turn.params.model, "gpt-6-astra");
  assert.equal(turn.params.effort, "ultra");

  const resumed = invokeTurn(binDir, cwd, {
    resumeThreadId: fresh.result.threadId,
    prompt: "continue",
    settings
  });
  assert.equal(resumed.ok, true, resumed.error?.message);
  state = JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
  const resume = state.requests.filter((request) => request.method === "thread/resume").at(-1);
  assert.equal(resume.params.model, "gpt-6-astra");
  assert.equal(resume.params.config.model_context_window, 1000000);
  assert.equal(resume.params.config.model_auto_compact_token_limit, 800000);
  assert.equal(resume.params.config.model_reasoning_effort, "ultra");
  assert.equal(resume.params.config.review_model, "gpt-6-astra");
  assert.deepEqual(resume.params.config.features, { multi_agent: false });
  assert.match(resume.params.developerInstructions, /Complete the authorized requested work/i);
  assert.match(resume.params.developerInstructions, /Do not begin with generic brainstorming/i);

  const resumeCount = state.requests.filter((request) => request.method === "thread/resume").length;
  const turnCount = state.requests.filter((request) => request.method === "turn/start").length;
  const otherCwd = makeTempDir();
  const mismatch = invokeTurn(binDir, otherCwd, {
    resumeThreadId: fresh.result.threadId,
    prompt: "do not run",
    settings
  });
  assert.equal(mismatch.ok, false);
  assert.match(mismatch.error.message, /Cannot resume Codex thread .* in a different workspace/i);
  assert.match(mismatch.error.message, /start a new task with --fresh/i);
  state = JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
  assert.equal(state.requests.filter((request) => request.method === "thread/resume").length, resumeCount);
  assert.equal(state.requests.filter((request) => request.method === "turn/start").length, turnCount);
});

test("terminal error notifications complete failed turns while retryable errors can recover", () => {
  const cwd = makeTempDir();
  const terminalBin = makeTempDir();
  installInstrumentedFakeCodex(terminalBin, "terminal-error");
  const terminal = invokeTurn(terminalBin, cwd, {
    prompt: "fail clearly",
    settings: resolveRuntimeSettings({ turnTimeoutMs: 1000, env: {} })
  });
  assert.equal(terminal.ok, true, terminal.error?.message);
  assert.equal(terminal.result.status, 1);
  assert.equal(terminal.result.error.message, "model is not supported for this account");

  const retryBin = makeTempDir();
  installInstrumentedFakeCodex(retryBin, "retryable-error");
  const retried = invokeTurn(retryBin, cwd, {
    prompt: "retry once",
    settings: resolveRuntimeSettings({ turnTimeoutMs: 1000, env: {} })
  });
  assert.equal(retried.ok, true, retried.error?.message);
  assert.equal(retried.result.status, 0);
  assert.equal(retried.result.error, null);
  assert.equal(retried.result.finalMessage, "Recovered after retry.");
});

test("transport exit rejects instead of leaving capture pending", () => {
  const cwd = makeTempDir();
  const binDir = makeTempDir();
  installInstrumentedFakeCodex(binDir, "transport-close");
  const result = invokeTurn(binDir, cwd, {
    prompt: "close transport",
    settings: resolveRuntimeSettings({ turnTimeoutMs: 1000, env: {} })
  });
  assert.equal(result.ok, false);
  assert.match(result.error.message, /connection closed before the turn completed/i);
});

test("turn timeout and AbortSignal both request interruption and reject promptly", () => {
  const cwd = makeTempDir();
  const timeoutBin = makeTempDir();
  installInstrumentedFakeCodex(timeoutBin, "no-completion");
  const timedOut = invokeTurn(timeoutBin, cwd, {
    prompt: "wait forever",
    settings: resolveRuntimeSettings({ turnTimeoutMs: 50, env: {} })
  });
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.error.code, "CODEX_TURN_TIMEOUT");
  assert.equal(timedOut.error.timeoutMs, 50);
  let state = JSON.parse(fs.readFileSync(path.join(timeoutBin, "fake-codex-state.json"), "utf8"));
  assert.equal(state.requests.some((request) => request.method === "turn/interrupt"), true);

  const abortBin = makeTempDir();
  installInstrumentedFakeCodex(abortBin, "no-completion");
  const aborted = invokeTurn(
    abortBin,
    cwd,
    {
      prompt: "abort this",
      settings: resolveRuntimeSettings({ turnTimeoutMs: 1000, env: {} })
    },
    250
  );
  assert.equal(aborted.ok, false);
  assert.equal(aborted.error.message, "job watchdog expired");
  state = JSON.parse(fs.readFileSync(path.join(abortBin, "fake-codex-state.json"), "utf8"));
  assert.equal(state.requests.some((request) => request.method === "turn/interrupt"), true);
});
