# Codex for Claude Code — Astra / WSL fork

This fork of [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) runs Codex from Claude Code with durable background jobs. Marketplace: `codex-astra`. Commands remain `/codex:*`.

## Install in WSL

Use native Linux Node.js (18.18+) and a current native Codex CLI. Astra was verified with Codex 0.154.0 and the existing ChatGPT login.

```bash
claude plugin marketplace add Barsoomx/codex-plugin-cc
claude plugin install codex@codex-astra
```

Restart Claude Code, then run `/codex:setup`. Local installation also accepts `claude plugin marketplace add /absolute/path/to/checkout`. Disable any older enabled `codex` plugin to avoid duplicate command names; its source and cache can be retained. See [WSL validation and migration](docs/WSL-VALIDATION.md).

For subsequent releases:

```bash
claude plugin marketplace update codex-astra
claude plugin update codex@codex-astra
```

Claude caches plugin versions: a source edit alone does not update the installed plugin. Release with `node scripts/bump-version.mjs <version>` before updating.

## Defaults

| Setting | Default |
|---|---|
| Model / reasoning | `gpt-6-astra` / `ultra` |
| Requested context / compaction | 1,000,000 / 800,000 tokens |
| Turn / job deadline | 10,800,000 ms / 3 hours each |
| Codex agent job budget | 9,600 seconds |
| Nested agents | Off unless `--multi-agent` is requested |
| Runtime | Direct app-server owned by each worker |

The server can cap requested context. A live WSL Astra/ultra turn reported **828,400 usable tokens** with a request of 1,000,000. Status records requested settings separately from Codex's observed context window.

All task/review commands accept `--model`, `--effort`, `--context-window`, `--auto-compact-token-limit`, `--turn-timeout-ms`, `--job-timeout-ms`, and `--agent-timeout-seconds`. Aliases: `astra`, `sol`, `luna`, `terra`, `spark`. Explicit other models do not receive Astra-specific context/effort defaults. `max` and `ultra` are supported when the selected model supports them.

Environment overrides: `CODEX_COMPANION_MODEL`, `CODEX_COMPANION_EFFORT`, `CODEX_COMPANION_CONTEXT_WINDOW`, `CODEX_COMPANION_AUTO_COMPACT_TOKEN_LIMIT`, `CODEX_COMPANION_TURN_TIMEOUT_MS`, `CODEX_COMPANION_JOB_TIMEOUT_MS`, `CODEX_COMPANION_AGENT_TIMEOUT_SECONDS`, `CODEX_COMPANION_MULTI_AGENT`. Command flags take precedence.

`CODEX_COMPANION_CODEX_BIN=/absolute/path/to/codex` selects a binary explicitly. WSL discovery prefers native Codex over inherited Windows shims. The plugin runs inside WSL; it does not transport Windows Claude into WSL.

## Tasks and results

Task/review commands detach by default. A worker owns the Codex process, deadline and log; jobs and results survive the originating Claude session ending. `--wait` starts the same durable job and waits for its result. Closing that waiting shell does not cancel the worker.

```text
/codex:rescue --model astra --effort ultra investigate the retry failure
/codex:status task-... --wait
/codex:result task-...
/codex:cancel task-...
```

The `codex:codex-rescue` subagent is a launcher. A background receipt means the task was launched; retrieve its result when complete. Failures expose the Codex error in status/result. Explicit job IDs work from another workspace directory.

CLI examples (set `PLUGIN` to the installed plugin directory):

```bash
node "$PLUGIN/scripts/codex-companion.mjs" task --write --fresh --prompt-file prompt.txt
node "$PLUGIN/scripts/codex-companion.mjs" task --resume <thread-id> --prompt-file followup.txt
node "$PLUGIN/scripts/codex-companion.mjs" status <job-id> --wait --json
node "$PLUGIN/scripts/codex-companion.mjs" result <job-id>
```

`--resume <thread-id>` selects an exact thread; `--resume-last` explicitly selects the latest tracked task; `--fresh` creates a new thread. `task --help` cannot launch Codex. Unknown flags fail early; use `--` before literal prompt text starting with a dash.

Claude command wrappers write a JSON array of argument strings using the Write tool and pass only its path as `--args-file /tmp/request.json`. They do not splice user text into executable shell commands. Direct CLI arguments remain supported; a single string containing multiple flags is no longer reparsed.

## Reviews

`/codex:review` uses Codex's native reviewer with model/effort applied to the thread. It accepts working-tree changes or `--base <ref>`. Focus text requires `--headless` or `/codex:adversarial-review`.

```text
/codex:review --base main --model astra --effort ultra
/codex:review --headless --base main --output-file /tmp/review.md check retry and cancellation behavior
/codex:adversarial-review --headless --base main challenge ownership assumptions
```

`--headless` creates an independent checkout containing only the snapshot. Working-tree snapshots include staged, unstaged and nonignored untracked files. Branch bases are pinned to commits. The runtime uses read-only sandboxing, `approvalPolicy=never`, an ephemeral thread, and disables skill instruction injection. Reviewers are instructed to use only the snapshot, without tests, builds or linters. Read-only sandboxing prevents writes; it is not filesystem read confinement. Saved verdicts use repository-relative paths. Temporary snapshots are cleaned after execution.

`/codex:adversarial-review` uses the same target selection, accepts focus with `--base`, and returns structured findings. Both review commands accept `--prompt-file` for long focus text and `--output-file` for the verdict.

Other commands: `/codex:setup` checks runtime/auth; `/codex:transfer` imports a Claude transcript; `/codex:status`, `/codex:result`, `/codex:cancel` manage jobs. The optional stop review gate remains off by default.

Prompts follow [Astra guidance](https://developers.openai.com/api/docs/guides/latest-model/gpt-6-astra.md), with bounded tasks, concise evidence, follow-through and no unsolicited delegation. See the [fork/issue audit](docs/FORK-AUDIT.md).

## Development

```bash
npm ci
npm test
npm run check-version
npm run build
```

Build generation uses installed Codex app-server types. Runtime tests use fake Codex and make no model calls. Review-only work must not run tests. Original OpenAI code remains Apache-2.0; see `LICENSE` and `plugins/codex/NOTICE`.
