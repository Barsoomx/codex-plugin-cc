import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "codex");

function read(relativePath) {
  return fs.readFileSync(path.join(PLUGIN_ROOT, relativePath), "utf8");
}

function assertTokenSafeLauncher(source, subcommand) {
  assert.match(source, /raw slash-command arguments/i);
  assert.match(source, /input data/i);
  assert.match(source, /`\$ARGUMENTS`/);
  assert.match(source, /Write.*structured argument/i);
  assert.match(source, /unique absolute temporary/i);
  assert.match(source, /--args-file/);
  assert.match(source, /static `Bash\(node:\*\)` root probe/i);
  assert.match(source, /CLAUDE_PLUGIN_ROOT.*CODEX_COMPANION_ROOT/i);
  assert.match(source, /Do not include user arguments in (that probe|it)/i);
  assert.match(source, new RegExp(`node "<absolute plugin root>/scripts/codex-companion\\.mjs" ${subcommand} --args-file "<absolute args-file path>" --consume-args-file`));
  assert.doesNotMatch(source, /!`/);
  for (const match of source.matchAll(/```bash\r?\n([\s\S]*?)```/g)) {
    assert.doesNotMatch(match[1], /\$ARGUMENTS/);
  }
}

test("review command uses a token-safe args file and preserves review rules", () => {
  const source = read("commands/review.md");

  assertTokenSafeLauncher(source, "review");
  assert.match(source, /allowed-tools: Write, Bash\(node:\*\)/);
  assert.match(source, /flags and their values as separate tokens/i);
  assert.match(source, /complete focus text as one final token/i);
  assert.match(source, /append `--`/i);
  assert.match(source, /--prompt-file.*one token/i);
  assert.match(source, /detached and queued by default/i);
  assert.match(source, /--background.*explicit/i);
  assert.match(source, /--wait.*waiting/i);
  assert.match(source, /job ID and log path/i);
  assert.match(source, /status <job-id> --wait/);
  assert.match(source, /result <job-id>/);
  assert.match(source, /do not present a queued launch as the final review/i);
  assert.match(source, /review-only/i);
  assert.match(source, /without edits, patches, or tests/i);
  assert.match(source, /--headless --base <ref> --output-file <path>/);
  assert.match(source, /isolated, read-only ephemeral snapshot/i);
  assert.match(source, /disables repository skills/i);
  assert.match(source, /does not accept inline focus text/i);
});

test("adversarial review uses token-safe focus forwarding", () => {
  const source = read("commands/adversarial-review.md");

  assertTokenSafeLauncher(source, "adversarial-review");
  assert.match(source, /allowed-tools: Write, Bash\(node:\*\)/);
  assert.match(source, /complete adversarial focus text as one final token/i);
  assert.match(source, /detached and queued by default/i);
  assert.match(source, /job ID and log path/i);
  assert.match(source, /status <job-id> --wait/);
  assert.match(source, /result <job-id>/);
  assert.match(source, /always accepts focus text/i);
  assert.match(source, /read-only and run no tests/i);
  assert.match(source, /challenges the selected implementation/i);
});

test("rescue parent writes args and passes concrete paths to the Agent wrapper", () => {
  const source = read("commands/rescue.md");

  assert.match(source, /allowed-tools: Write, Bash\(node:\*\), Agent/);
  assert.match(source, /subagent_type: "codex:codex-rescue"/);
  assert.match(source, /maxTurns: 1000/);
  assert.match(source, /do not pass `maxTurns` as an Agent tool argument/i);
  assert.match(source, /Do not invoke a skill for rescue/i);
  assert.match(source, /Write.*structured argument/i);
  assert.match(source, /absolute plugin root.*absolute args-file path/i);
  assert.match(source, /static `Bash\(node:\*\)` root probe/i);
  assert.match(source, /parent prepares the safe argument file/i);
  assert.match(source, /one Bash call equivalent to/i);
  assert.match(source, /task --args-file/);
  assert.match(source, /--consume-args-file/);
  assert.match(source, /does not.*parse task text/i);
  assert.match(source, /detached and queued by default/i);
  assert.match(source, /--resume <thread-id>/);
  assert.match(source, /--resume-last/);
  assert.match(source, /--fresh/);
  assert.match(source, /Do not select or resume an unrelated latest thread/i);
  assert.match(source, /do not ask for confirmation/i);
  assert.match(source, /astra.*sol.*luna.*terra.*spark/i);
  assert.match(source, /max.*ultra/i);
  assert.match(source, /Construct `--write`/i);
  assert.doesNotMatch(source, /!`/);
});

test("rescue agent only forwards the parent's concrete args file", () => {
  const source = read("agents/codex-rescue.md");

  assert.match(source, /maxTurns: 1000/);
  assert.match(source, /tools: Bash/);
  assert.match(source, /codex-cli-runtime/);
  assert.match(source, /gpt-6-astra-prompting/);
  assert.match(source, /exactly one Bash call/i);
  assert.match(source, /concrete absolute plugin root and.*absolute JSON args-file path/i);
  assert.match(source, /Do not reconstruct them from environment variables/i);
  assert.match(source, /task --args-file/);
  assert.match(source, /--consume-args-file/);
  assert.match(source, /JSON array of string tokens/i);
  assert.match(source, /complete task text.*one token after `--`/i);
  assert.match(source, /Do not use `eval`, shell interpolation, or a raw command-placeholder expansion/i);
  assert.match(source, /--resume <thread-id>/);
  assert.match(source, /--resume-last/);
  assert.match(source, /--fresh/);
  assert.match(source, /Do not inspect the repository/i);
  assert.match(source, /Do not call review, adversarial-review, status, result, or cancel/i);
  for (const match of source.matchAll(/```bash\r?\n([\s\S]*?)```/g)) {
    assert.doesNotMatch(match[1], /\$ARGUMENTS/);
  }
});

test("runtime skill documents args-file forwarding and runtime defaults", () => {
  const source = read("skills/codex-cli-runtime/SKILL.md");

  assert.match(source, /user-invocable: false/);
  assert.match(source, /concrete absolute values.*args-file path/i);
  assert.match(source, /task --args-file/);
  assert.match(source, /--consume-args-file/);
  assert.match(source, /JSON array of string tokens/i);
  assert.match(source, /complete task text as one token after `--`/i);
  assert.match(source, /Never use a raw command placeholder/i);
  assert.match(source, /one `task` invocation/i);
  assert.match(source, /detached and queued by default/i);
  assert.match(source, /--wait.*durable detached worker/i);
  assert.match(source, /--resume <thread-id>/);
  assert.match(source, /--resume-last/);
  assert.match(source, /--fresh/);
  assert.match(source, /gpt-6-astra.*ultra/i);
  assert.match(source, /context-window 1000000/);
  assert.match(source, /auto-compact-token-limit 800000/);
  assert.match(source, /turn-timeout-ms 10800000/);
  assert.match(source, /job-timeout-ms 10800000/);
  assert.match(source, /agent-timeout-seconds 9600/);
  assert.match(source, /--multi-agent/);
  assert.match(source, /default task has no subagents/i);
});

test("result handling preserves args-file and queued-result boundaries", () => {
  const source = read("skills/codex-result-handling/SKILL.md");

  assert.match(source, /structured `Write` call/i);
  assert.match(source, /--args-file/);
  assert.match(source, /raw command input as nonexecuting data/i);
  assert.match(source, /complete task or focus text after `--` as one token/i);
  assert.match(source, /queued record/i);
  assert.match(source, /job ID and log path/i);
  assert.match(source, /status <job-id> --wait/);
  assert.match(source, /result <job-id>/);
  assert.match(source, /never present the launch as a final review/i);
  assert.match(source, /never silently discard a failed worker/i);
  assert.match(source, /do not turn it into a Claude-side implementation/i);
  assert.match(source, /After presenting review findings, stop/i);
});

test("deterministic commands use the same structured args-file route", () => {
  for (const [command, subcommand] of [
    ["status", "status"],
    ["result", "result"],
    ["cancel", "cancel"],
    ["setup", "setup"],
    ["transfer", "transfer"]
  ]) {
    const source = read(`commands/${command}.md`);
    assertTokenSafeLauncher(source, subcommand);
    assert.match(source, /Write.*structured argument/i);
  }
});

test("continue is not exposed as a separate command", () => {
  const commandFiles = fs.readdirSync(path.join(PLUGIN_ROOT, "commands")).sort();
  assert.deepEqual(commandFiles, [
    "adversarial-review.md",
    "cancel.md",
    "rescue.md",
    "result.md",
    "review.md",
    "setup.md",
    "status.md",
    "transfer.md"
  ]);
});
