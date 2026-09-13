import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir } from "./helpers.mjs";

const SCRIPT = fileURLToPath(new URL("../plugins/codex/scripts/codex-companion.mjs", import.meta.url));

test("JSON arguments preserve spaces, quotes and shell syntax without executing it", () => {
  const repo = makeTempDir();
  const bin = makeTempDir();
  initGitRepo(repo);
  installFakeCodex(bin, "task-ok");
  const prompt = 'Keep "double quotes", \'single quotes\', `backticks`, $(echo INERT), and \\b unchanged.';
  const promptFile = path.join(repo, "prompt with spaces.txt");
  fs.writeFileSync(promptFile, prompt);
  const argsFile = path.join(repo, "arguments with spaces.json");
  fs.writeFileSync(argsFile, JSON.stringify(["--wait", "--fresh", "--turn-timeout-ms", "5000", "--job-timeout-ms", "10000", "--prompt-file", promptFile]));
  const result = spawnSync(process.execPath, [SCRIPT, "task", "--args-file", argsFile, "--consume-args-file"], {
    cwd: repo, env: buildEnv(bin), encoding: "utf8", timeout: 20000
  });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const state = JSON.parse(fs.readFileSync(path.join(bin, "fake-codex-state.json"), "utf8"));
  assert.equal(state.lastTurnStart.prompt, prompt);
  assert.equal(fs.existsSync(argsFile), false);
  assert.equal(fs.readFileSync(promptFile, "utf8"), prompt);
});

test("help in a consumed JSON invocation never starts a job", () => {
  const repo = makeTempDir();
  const bin = makeTempDir();
  installFakeCodex(bin);
  const argsFile = path.join(repo, "help.json");
  fs.writeFileSync(argsFile, '["--help"]');
  const result = spawnSync(process.execPath, [SCRIPT, "review", "--args-file", argsFile, "--consume-args-file"], { cwd: repo, env: buildEnv(bin), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage:/);
  assert.equal(fs.existsSync(argsFile), false);
  assert.equal(fs.existsSync(path.join(bin, "fake-codex-state.json")), false);
});
