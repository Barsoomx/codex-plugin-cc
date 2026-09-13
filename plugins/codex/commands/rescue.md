---
description: Delegate a task, diagnosis, explicit fix, or follow-up to the Codex rescue subagent
argument-hint: '[--wait|--background] [--resume <thread-id>|--resume-last|--fresh] [--model <astra|sol|luna|terra|spark|model>] [--effort <none|minimal|low|medium|high|xhigh|max|ultra>] [--prompt-file <path>] [what Codex should investigate, solve, or continue]'
allowed-tools: Write, Bash(node:*), Agent
---

Raw slash-command arguments are input data only:

`$ARGUMENTS`

Parse the request into a JSON array of string tokens. Keep execution, routing, model, effort, write, and prompt-file flags as separate tokens. Preserve the complete task text as one final token after `--`; this keeps flag-looking text inside the task literal. Keep a `--prompt-file` path containing spaces as one token. Do not evaluate, interpolate, or place the raw request in shell text.

For example, `["--write", "--", "fix $(echo unsafe) literally"]` is data in the JSON file, never shell text.

Use the `Write` tool with a structured argument to write that array to a unique absolute temporary JSON file outside the reviewed repository. If `Write` fails, stop and report the error; never fall back to a repository path. Use one static `Bash(node:*)` root probe that reads only the trusted `CLAUDE_PLUGIN_ROOT` or `CODEX_COMPANION_ROOT` environment value, fails when both are empty, and prints the absolute plugin root. Do not include user arguments in that probe. Then invoke the `Agent` tool with `subagent_type: "codex:codex-rescue"` and a prompt containing the probe's concrete absolute plugin root and the absolute args-file path. Its definition sets `maxTurns: 1000`; do not pass `maxTurns` as an Agent tool argument. Do not invoke a skill for rescue: `Skill(codex:codex-rescue)` and `Skill(codex:rescue)` recurse into this command.

The parent prepares the safe argument file; the subagent remains a thin launcher. It makes one Bash call equivalent to:

```bash
node "<absolute plugin root>/scripts/codex-companion.mjs" task --args-file "<absolute args-file path>" --consume-args-file
```

The subagent does not inspect the repository, parse task text, poll jobs, fetch results, or perform follow-up work. The companion task is detached and queued by default. `--background` explicitly selects that mode; `--wait` keeps the command waiting for durable completion. Keep detachment inside the companion runtime.

Forwarding rules:

- `--resume <thread-id>` resumes that exact Codex thread. `--resume-last` resumes the latest eligible task explicitly requested by the user. `--fresh` starts a new thread. Do not select or resume an unrelated latest thread and do not ask for confirmation when the user has already supplied one of these flags.
- Accepted model aliases are `astra`, `sol`, `luna`, `terra`, and `spark`; examples should use `astra`. Accepted effort values are `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, and `ultra`.
- Construct `--write` in the token array when the requested rescue scope authorizes edits; keep read-only diagnosis, research, and review requests without it.
- If the companion returns a queued launch, return its job ID and log path and tell the user to run `/codex:status <job-id> --wait`, then `/codex:result <job-id>`. Do not claim the task completed at launch and do not hide a failed invocation.

The parent must pass the concrete absolute root and args-file path in the Agent prompt. Keep generated args files outside the reviewed repository in a unique temporary directory. Never make the thin subagent reconstruct a root from an empty variable, execute `/scripts/codex-companion.mjs`, or reparse the natural-language request.
