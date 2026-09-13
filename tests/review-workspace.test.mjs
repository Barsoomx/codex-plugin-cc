import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { normalizeReviewPaths, prepareReviewWorkspace } from "../plugins/codex/scripts/lib/review-workspace.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";

function commit(cwd, message, files) {
  for (const [name, contents] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(cwd, name)), { recursive: true });
    fs.writeFileSync(path.join(cwd, name), contents);
  }
  run("git", ["add", "--all"], { cwd });
  assert.equal(run("git", ["commit", "-m", message], { cwd }).status, 0);
}

test("working-tree snapshot contains total tracked diff and nonignored untracked files", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  commit(cwd, "base", { "app.js": "export const value = 'base';\n", ".gitignore": "ignored.txt\n" });

  fs.writeFileSync(path.join(cwd, "app.js"), "export const value = 'staged';\n");
  run("git", ["add", "app.js"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), "export const value = 'current';\n");
  fs.writeFileSync(path.join(cwd, "new-risk.js"), "export const risk = true;\n");
  fs.writeFileSync(path.join(cwd, "ignored.txt"), "secret\n");
  const statusBefore = run("git", ["status", "--short", "--untracked-files=all"], { cwd }).stdout;

  const snapshot = prepareReviewWorkspace(cwd, {
    mode: "working-tree",
    label: "working tree diff",
    explicit: true
  });

  assert.notEqual(snapshot.cwd, cwd);
  assert.equal(fs.readFileSync(path.join(snapshot.cwd, "app.js"), "utf8"), "export const value = 'current';\n");
  assert.equal(fs.readFileSync(path.join(snapshot.cwd, "new-risk.js"), "utf8"), "export const risk = true;\n");
  assert.equal(fs.existsSync(path.join(snapshot.cwd, "ignored.txt")), false);
  assert.equal(run("git", ["diff", "--quiet", "HEAD", "--", "app.js"], { cwd: snapshot.cwd }).status, 1);

  snapshot.cleanup();
  snapshot.cleanup();
  assert.equal(fs.existsSync(snapshot.cwd), false);
  assert.equal(run("git", ["status", "--short", "--untracked-files=all"], { cwd }).stdout, statusBefore);
  assert.equal(fs.readFileSync(path.join(cwd, "app.js"), "utf8"), "export const value = 'current';\n");
});

test("branch snapshot pins the source base commit and keeps the original label", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  commit(cwd, "base", { "app.js": "export const value = 'base';\n" });
  const baseCommit = run("git", ["rev-parse", "HEAD"], { cwd }).stdout.trim();
  assert.equal(run("git", ["checkout", "-b", "feature"], { cwd }).status, 0);
  commit(cwd, "feature", { "app.js": "export const value = 'feature';\n" });

  const sourceHead = run("git", ["rev-parse", "HEAD"], { cwd }).stdout.trim();
  const sourceRefs = run("git", ["show-ref"], { cwd }).stdout;
  const snapshot = prepareReviewWorkspace(cwd, {
    mode: "branch",
    label: "branch diff against main",
    baseRef: "main",
    explicit: true
  });

  assert.equal(snapshot.target.baseRef, baseCommit);
  assert.equal(snapshot.target.sourceBaseRef, "main");
  assert.equal(snapshot.target.label, "branch diff against main");
  assert.equal(run("git", ["rev-parse", "HEAD"], { cwd: snapshot.cwd }).stdout.trim(), sourceHead);
  assert.equal(run("git", ["diff", "--quiet", `${baseCommit}...HEAD`], { cwd: snapshot.cwd }).status, 1);
  const snapshotConfig = run("git", ["config", "--list", "--show-origin"], { cwd: snapshot.cwd }).stdout;
  assert.doesNotMatch(snapshotConfig, new RegExp(cwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(run("git", ["config", "--get", "remote.origin.url"], { cwd: snapshot.cwd }).status, 1);
  assert.doesNotMatch(run("git", ["reflog", "show", "--all"], { cwd: snapshot.cwd }).stdout, new RegExp(cwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.deepEqual(fs.readdirSync(path.dirname(snapshot.cwd)), ["checkout"]);

  snapshot.cleanup();
  assert.equal(fs.existsSync(cwd), true);
  assert.equal(run("git", ["rev-parse", "HEAD"], { cwd }).stdout.trim(), sourceHead);
  assert.equal(run("git", ["show-ref"], { cwd }).stdout, sourceRefs);
});

test("separate snapshots do not share checkout directories", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  commit(cwd, "base", { "app.js": "export const value = 'base';\n" });
  fs.writeFileSync(path.join(cwd, "app.js"), "export const value = 'changed';\n");

  const first = prepareReviewWorkspace(cwd, { mode: "working-tree", label: "working tree diff" });
  const second = prepareReviewWorkspace(cwd, { mode: "working-tree", label: "working tree diff" });

  assert.notEqual(path.dirname(first.cwd), path.dirname(second.cwd));
  fs.writeFileSync(path.join(first.cwd, "only-first.txt"), "first\n");
  assert.equal(fs.existsSync(path.join(second.cwd, "only-first.txt")), false);
  first.cleanup();
  assert.equal(fs.existsSync(second.cwd), true);
  second.cleanup();
});

test("normalizeReviewPaths removes snapshot and source roots", () => {
  const snapshotRoot = path.join("C:", "tmp", "codex-review-abcd", "checkout");
  const sourceRoot = path.join("C:", "work", "repository");
  const text = "- [P1] Problem — " + snapshotRoot + "\\src\\app.js:12\n- [P2] Other — " + sourceRoot + "/lib/util.js:4";

  assert.equal(
    normalizeReviewPaths(text, snapshotRoot, sourceRoot),
    "- [P1] Problem — src/app.js:12\n- [P2] Other — lib/util.js:4"
  );
});
