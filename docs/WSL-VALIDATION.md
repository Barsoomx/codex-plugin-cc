# WSL validation and migration

## Preserving the previous installation

The previous plugin is `codex@codex-local` 1.0.6-local.2. Its native source checkout is `/root/src/codex-plugin-cc`, branch `local-hardening`, with pre-existing uncommitted changes in the companion and runtime modules. Do not reset, clean, overwrite or remove that checkout.

This release uses the separate `codex-astra` marketplace. A native checkout can be installed without replacing the old source:

```bash
git clone https://github.com/Barsoomx/codex-plugin-cc /root/src/codex-plugin-cc-astra
claude plugin marketplace add /root/src/codex-plugin-cc-astra
claude plugin install codex@codex-astra
claude plugin disable codex@codex-local
```

Restart Claude Code after changing enabled plugins. The new plugin keeps `/codex:*` command names. Disabling the old plugin preserves its files and leaves already-running processes alone. To roll back, disable `codex@codex-astra` and enable `codex@codex-local`.

For updates, pull the native checkout and run `claude plugin marketplace update codex-astra` followed by `claude plugin update codex@codex-astra`. Verify the installed cache version, not only the source checkout.

## Live source validation — 2026-09-13

Native runtime: Ubuntu-24.04 WSL, Node 22.21.1, Codex 0.154.0, Claude Code 2.1.270. Existing ChatGPT authentication was reused.

| Scenario | Observed result |
|---|---|
| Fresh task through companion | `gpt-6-astra`, `ultra`, response `ASTRA_PLUGIN_OK`, successful job |
| Requested 1M / compact 800k | Server reported 828,400 usable context tokens |
| Explicit resume of same thread, requested 800k / compact 700k | Same thread ID, Astra/ultra, server reported 760,000 usable tokens |
| Headless branch review with focus and output file | Found a seeded addition-to-subtraction regression in `sum.mjs:2`; saved repository-relative verdict; snapshot cleaned |
| Native review with `--effort ultra` | Found the same seeded regression; review-only completion |
| Job lookup from a different cwd | Resolved the exact review ID and returned its actual workspace |
| Claude plugin manifest validation | Passed via native `claude plugin validate` |
| Actual Claude Code `/codex:setup` with the plugin directory | 4 turns, success, no permission denials; reported new defaults and direct runtime |
| Actual Claude Code `/codex:rescue --wait --model astra --effort ultra` | One `codex:codex-rescue` Agent spawned/completed; Codex returned `CC_TO_ASTRA_OK`; no permission denials; args file consumed |

Native review did not emit a context-usage notification in this probe, so its observed context field is null. Requested settings remain recorded. Other scenarios above report server-observed values, not inferred values from TOML.

The source validation uses small isolated fixtures. It does not claim a multi-hour workload has been run for three hours. Deadlines, disconnection, cancellation, broker cleanup and process lifetime are checked with deterministic fake-runtime regressions. Job cancellation is delivered through the owned worker's state record rather than an unverified numeric PID.

Read-only sandboxing prevents writes; it does not provide filesystem read confinement. Headless reviews remove the clone's source remote/reflog pointers, disable skill injection and restrict evidence to the disposable snapshot by instruction.
