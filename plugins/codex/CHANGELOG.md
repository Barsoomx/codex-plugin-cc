# Changelog

## 1.1.0

- Default to Astra/ultra with per-thread context, compaction and runtime budgets; report observed context separately.
- Run all tasks and reviews as durable jobs. Foreground waiting can end without stopping the job.
- Atomically claim/cancel jobs, preserve results, surface server errors, reconcile dead Linux workers, and resolve explicit IDs across workspaces.
- Use native WSL Codex and direct app-server processes by default; bound transport operations and clean owned broker state safely.
- Add explicit repository-checked thread resume, real help, structured argument files and configurable hour-scale deadlines.
- Add isolated headless reviews with focus plus base, disabled skill injection, strict output validation and saved relative-path verdicts.
- Tune prompts for Astra, disable unsolicited subagents, and keep every review free of test/build execution.
- Ship as `codex-astra`, preserving older `codex-local` installations for rollback.

## 1.0.0

- Initial version of the Codex plugin for Claude Code
