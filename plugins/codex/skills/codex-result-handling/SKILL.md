---
name: codex-result-handling
description: Internal guidance for preserving Codex queued, completed, and failed job output
user-invocable: false
---

# Codex Result Handling

Preserve the helper's output structure and evidence boundaries. Keep verdict, summary, findings, details, artifacts, next steps, uncertainty, file paths, line numbers, and errors exactly as reported.

Command wrappers must pass arguments through a JSON token array written with a structured `Write` call and invoke the companion with `--args-file --consume-args-file`; the generated temporary file is consumed after parsing. Treat raw command input as nonexecuting data. Preserve each flag and value token, and preserve complete task or focus text after `--` as one token.

When a task, review, or adversarial review starts detached, the launch output is only a queued record. It must retain the job ID and log path. Direct the user to `/codex:status <job-id> --wait` and then `/codex:result <job-id>`; never present the launch as a final review or completed task and never silently discard a failed worker.

For a completed review, present findings first in severity order and say explicitly when there are no findings. For a completed write task, identify the touched files when the helper provides them. Preserve observed facts, inferences, open questions, and follow-up steps as separate distinctions when the helper makes them.

For `codex:codex-rescue`, a failed, incomplete, or never-invoked Codex run ends the handoff. Report the actionable error and stop; do not turn it into a Claude-side implementation or substitute answer. After presenting review findings, stop without changing files or applying fixes. The user must request any fixes separately.

If output is malformed, include the most actionable stderr and parse-error details instead of guessing. If setup or authentication is required, direct the user to `/codex:setup`.
