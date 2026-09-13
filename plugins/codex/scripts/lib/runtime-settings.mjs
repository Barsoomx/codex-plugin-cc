const DEFAULT_MODEL = "gpt-6-astra";
const DEFAULT_ASTRA_EFFORT = "ultra";
const DEFAULT_ASTRA_CONTEXT_WINDOW = 1_000_000;
const DEFAULT_ASTRA_AUTO_COMPACT_TOKEN_LIMIT = 800_000;
const DEFAULT_TURN_TIMEOUT_MS = 3 * 60 * 60 * 1000;
const DEFAULT_AGENT_TIMEOUT_SECONDS = 9_600;

const MODEL_ALIASES = new Map([
  ["astra", DEFAULT_MODEL],
  ["spark", "gpt-5.3-codex-spark"],
  ["sol", "gpt-5.6-sol"],
  ["terra", "gpt-5.6-terra"],
  ["luna", "gpt-5.6-luna"]
]);
const VALID_REASONING_EFFORTS = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra"
]);
const UNSUPPORTED_ASTRA_EFFORTS = new Set(["none", "minimal"]);

function isPresent(value) {
  return value !== undefined && value !== null && (typeof value !== "string" || value.trim() !== "");
}

function optionOrEnv(optionValue, env, envName) {
  return isPresent(optionValue) ? optionValue : env?.[envName];
}

function normalizeModel(value) {
  if (!isPresent(value)) {
    return DEFAULT_MODEL;
  }
  const model = String(value).trim();
  return MODEL_ALIASES.get(model.toLowerCase()) ?? model;
}

function normalizeEffort(value, model) {
  if (!isPresent(value)) {
    return model === DEFAULT_MODEL ? DEFAULT_ASTRA_EFFORT : null;
  }
  const effort = String(value).trim().toLowerCase();
  if (!VALID_REASONING_EFFORTS.has(effort)) {
    throw new Error(
      `Unsupported reasoning effort "${value}". Use one of: none, minimal, low, medium, high, xhigh, max, ultra.`
    );
  }
  if (model === DEFAULT_MODEL && UNSUPPORTED_ASTRA_EFFORTS.has(effort)) {
    throw new Error(
      `GPT-6 Astra does not support reasoning effort "${effort}". Use low, medium, high, xhigh, max, or ultra.`
    );
  }
  return effort;
}

function positiveSafeInteger(value, label, fallback = null) {
  if (!isPresent(value)) {
    return fallback;
  }
  const number = Number(value);
  if (!Number.isFinite(number) || !Number.isSafeInteger(number) || number <= 0) {
    throw new Error(`${label} must be a finite positive safe integer.`);
  }
  return number;
}

function timeoutMilliseconds(value, fallback) {
  const timeout = positiveSafeInteger(value, "turn timeout", fallback);
  if (timeout > 2_147_483_647) {
    throw new Error("turn timeout must be no greater than 2147483647 ms.");
  }
  return timeout;
}

function normalizeBoolean(value, label, fallback = false) {
  if (!isPresent(value)) {
    return fallback;
  }
  if (typeof value === "boolean") {
    return value;
  }
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  throw new Error(`${label} must be true or false.`);
}

export function resolveRuntimeSettings(options = {}) {
  const env = options.env ?? process.env;
  const model = normalizeModel(optionOrEnv(options.model, env, "CODEX_COMPANION_MODEL"));
  const isAstra = model === DEFAULT_MODEL;
  const effort = normalizeEffort(
    optionOrEnv(options.effort, env, "CODEX_COMPANION_EFFORT"),
    model
  );
  const contextWindowValue = optionOrEnv(
    options.contextWindow,
    env,
    "CODEX_COMPANION_CONTEXT_WINDOW"
  );
  const autoCompactTokenLimitValue = optionOrEnv(
    options.autoCompactTokenLimit,
    env,
    "CODEX_COMPANION_AUTO_COMPACT_TOKEN_LIMIT"
  );
  const contextWindow = positiveSafeInteger(
    contextWindowValue,
    "context window",
    isAstra ? DEFAULT_ASTRA_CONTEXT_WINDOW : null
  );
  const implicitAstraAutoCompactTokenLimit = isAstra
    ? Math.min(DEFAULT_ASTRA_AUTO_COMPACT_TOKEN_LIMIT, Math.floor(contextWindow * 0.9))
    : null;
  if (implicitAstraAutoCompactTokenLimit !== null && implicitAstraAutoCompactTokenLimit <= 0) {
    throw new Error("Astra context window must be greater than 1 token.");
  }
  const autoCompactTokenLimit = positiveSafeInteger(
    autoCompactTokenLimitValue,
    "auto-compact token limit",
    implicitAstraAutoCompactTokenLimit
  );

  if (autoCompactTokenLimit !== null && contextWindow === null) {
    throw new Error("auto-compact token limit requires a context window.");
  }
  if (
    autoCompactTokenLimit !== null &&
    contextWindow !== null &&
    autoCompactTokenLimit >= contextWindow
  ) {
    throw new Error("auto-compact token limit must be smaller than the context window.");
  }

  return {
    model,
    effort,
    contextWindow,
    autoCompactTokenLimit,
    turnTimeoutMs: timeoutMilliseconds(
      optionOrEnv(options.turnTimeoutMs, env, "CODEX_COMPANION_TURN_TIMEOUT_MS"),
      DEFAULT_TURN_TIMEOUT_MS
    ),
    agentTimeoutSeconds: positiveSafeInteger(
      optionOrEnv(options.agentTimeoutSeconds, env, "CODEX_COMPANION_AGENT_TIMEOUT_SECONDS"),
      "agent timeout",
      DEFAULT_AGENT_TIMEOUT_SECONDS
    ),
    multiAgent: normalizeBoolean(
      optionOrEnv(options.multiAgent, env, "CODEX_COMPANION_MULTI_AGENT"),
      "multi-agent setting"
    ),
    headless: normalizeBoolean(options.headless, "headless setting")
  };
}

export {
  DEFAULT_AGENT_TIMEOUT_SECONDS,
  DEFAULT_ASTRA_AUTO_COMPACT_TOKEN_LIMIT,
  DEFAULT_ASTRA_CONTEXT_WINDOW,
  DEFAULT_ASTRA_EFFORT,
  DEFAULT_MODEL,
  DEFAULT_TURN_TIMEOUT_MS
};
