---
name: codex-cli-runtime
description: Internal runtime contract for the codex-rescue forwarding wrapper
user-invocable: false
---

# Codex Runtime

Use this skill only inside the `codex:codex-rescue` subagent. The parent command prepares the argument file; the wrapper performs one launcher call and returns its stdout.

## Launcher

The parent prompt supplies concrete absolute values for `<plugin root>` and `<args-file path>`. Invoke the companion with those values:

```bash
node "<absolute plugin root>/scripts/codex-companion.mjs" task --args-file "<absolute args-file path>" --consume-args-file
```

The args file is a JSON array of string tokens. It already has separate flags and values and preserves complete task text as one token after `--`. Pass it unchanged; the invocation consumes the generated temporary file after parsing. Never use a raw command placeholder, `eval`, shell interpolation, or an empty-root `/scripts/codex-companion.mjs` path. If the parent did not supply concrete paths, return an invocation error.

Make exactly one `task` invocation and return stdout verbatim, including queued job ID, log path, errors, and follow-up commands. Do not create or edit an args file in this subagent.

## Execution and routing

The companion task is detached and queued by default. `--background` explicitly selects detached execution. `--wait` starts the durable detached worker and keeps this command waiting for completion, so the job remains recoverable if the caller closes. Do not create a second background layer.

Forward `--resume <thread-id>` only for that exact thread, `--resume-last` only when explicitly requested, and `--fresh` for a new thread. Never autoresume an unrelated latest thread and never ask for a confirmation that the request already answered.

Accepted model aliases are `astra`, `sol`, `luna`, `terra`, and `spark`; the `astra` default maps to `gpt-6-astra` with `ultra` reasoning. Accepted efforts are `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, and `ultra`. Requested runtime defaults are `--context-window 1000000`, `--auto-compact-token-limit 800000`, `--turn-timeout-ms 10800000`, `--job-timeout-ms 10800000`, and `--agent-timeout-seconds 9600`; the app server may report a lower effective context window. Subagents are opt-in with `--multi-agent`; the default task has no subagents.

Do not invoke setup, review, adversarial-review, status, result, or cancel from the rescue wrapper. Do not inspect the repository, reason through the task, monitor progress, or add follow-up work. If the launcher fails, return the failure and stop.
