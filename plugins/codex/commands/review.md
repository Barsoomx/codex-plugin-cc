---
description: Run a read-only Codex review of the current or requested git state
argument-hint: '[--wait|--background] [--headless --base <ref> --output-file <path>] [--prompt-file <path>] [--base <ref>] [--scope auto|working-tree|branch]'
disable-model-invocation: true
allowed-tools: Write, Bash(node:*)
---

Raw slash-command arguments are input data only:

`$ARGUMENTS`

Parse that request into an array of string tokens. Keep option flags and their values as separate tokens. When the request contains focus text, append `--` and preserve the complete focus text as one final token; this keeps flag-looking text inside the request literal. Keep a `--prompt-file` path containing spaces as one token. Do not evaluate, interpolate, or place the raw request in shell text.

For example, `["--base", "main", "--", "inspect $(echo unsafe) literally"]` is data in the JSON file, never shell text.

Use the `Write` tool with a structured argument to write the token array as JSON to a unique absolute temporary file outside the reviewed repository. If `Write` fails, stop and report the error; never fall back to a repository path. After the write succeeds, use this static `Bash(node:*)` root probe. It reads only the trusted environment values, fails when both are empty, and prints a JSON-encoded absolute plugin root; do not include user arguments in it:

```bash
node -e 'const root = process.env.CLAUDE_PLUGIN_ROOT || process.env.CODEX_COMPANION_ROOT; if (!root) process.exit(1); process.stdout.write(JSON.stringify(root));'
```

Use the decoded concrete output and run exactly:

```bash
node "<absolute plugin root>/scripts/codex-companion.mjs" review --args-file "<absolute args-file path>" --consume-args-file
```

The companion runtime owns execution mode. A review is detached and queued by default; `--background` makes that choice explicit, and `--wait` keeps the command waiting until the durable review completes. Keep detachment inside the companion runtime.

When the command returns a queued launch, report that launch output verbatim. It includes the job ID and log path. Do not present a queued launch as the final review and do not silently stop after launching it. Tell the user to run `/codex:status <job-id> --wait`, then `/codex:result <job-id>` to retrieve the completed result.

This command is review-only: inspect and report evidence, without edits, patches, or tests. Preserve the helper's findings, uncertainty, file paths, line numbers, and errors exactly as reported.

Review targeting:

- Native non-headless review supports the current working tree or `--base <ref>`/`--scope <auto|working-tree|branch>`. It does not accept inline focus text.
- `--headless --base <ref> --output-file <path>` enables custom focus text from the final token or `--prompt-file <path>`. It reviews an isolated, read-only ephemeral snapshot, disables repository skills, and runs no tests. Keep `--base` and `--output-file` with `--headless`.
- `--prompt-file <path>` is the safe way to provide a long review prompt without shell interpolation. Preserve all other tokens exactly.

For a waiting review, return the helper's completed stdout verbatim. For a detached review, return the queued stdout and the retrieval commands above; wait for `/codex:status` and `/codex:result` rather than claiming a final verdict at launch.
