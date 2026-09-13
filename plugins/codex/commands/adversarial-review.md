---
description: Run a read-only Codex review that challenges implementation and design choices
argument-hint: '[--wait|--background] [--base <ref>] [--scope auto|working-tree|branch] [--prompt-file <path>] [focus ...]'
disable-model-invocation: true
allowed-tools: Write, Bash(node:*)
---

Raw slash-command arguments are input data only:

`$ARGUMENTS`

Parse the request into a JSON array of string tokens. Keep option flags and their values separate. Preserve the complete adversarial focus text as one final token after `--`, so flag-looking text inside the focus remains literal. Keep a `--prompt-file` path containing spaces as one token. Do not evaluate, interpolate, or place the raw request in shell text.

For example, `["--base", "main", "--", "question $(echo unsafe) literally"]` is data in the JSON file, never shell text.

Use the `Write` tool with a structured argument to write the token array to a unique absolute temporary JSON file outside the reviewed repository. If `Write` fails, stop and report the error; never fall back to a repository path. Use this static `Bash(node:*)` root probe. It reads only the trusted environment values, fails when both are empty, and prints a JSON-encoded absolute plugin root; do not include user arguments in it:

```bash
node -e 'const root = process.env.CLAUDE_PLUGIN_ROOT || process.env.CODEX_COMPANION_ROOT; if (!root) process.exit(1); process.stdout.write(JSON.stringify(root));'
```

Use the decoded concrete output and run exactly:

```bash
node "<absolute plugin root>/scripts/codex-companion.mjs" adversarial-review --args-file "<absolute args-file path>" --consume-args-file
```

The review is read-only and challenges the selected implementation, design, tradeoffs, assumptions, and failure modes. The companion runtime owns execution mode: detached and queued by default, explicitly detached with `--background`, or waiting with `--wait`. Keep detachment inside the companion runtime.

When the command returns a queued launch, return that output verbatim. It includes the job ID and log path. Do not call the launch a completed review or suppress a failure. Instruct the user to run `/codex:status <job-id> --wait`, then `/codex:result <job-id>` for the stored result.

Targeting and prompt handling:

- It supports working-tree review, branch review with `--base <ref>`, and `--scope <auto|working-tree|branch>`.
- It always accepts focus text after the flags. `--prompt-file <path>` supplies long focus text without shell interpolation.
- Review runs are read-only and run no tests. Preserve the helper's verdict, findings, evidence boundaries, paths, line numbers, and errors exactly as reported.

Return completed waiting output verbatim. For the default or `--background` path, return only the queued launch output and the status/result retrieval path until the user asks for those commands.
