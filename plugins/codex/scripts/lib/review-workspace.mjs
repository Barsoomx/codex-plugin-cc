import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runCommandChecked } from "./process.mjs";

const REVIEW_TEMP_PREFIX = "codex-review-";
const CHECKOUT_NAME = "checkout";
const DIFF_MAX_BUFFER = 512 * 1024 * 1024;

function gitChecked(cwd, args, options = {}) {
  return runCommandChecked("git", args, { cwd, ...options, shell: false });
}

function parseNullSeparated(value) {
  return value.split("\0").filter(Boolean);
}

function canonicalPath(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isWithin(root, candidate) {
  const normalizedRoot = canonicalPath(root);
  const normalizedCandidate = canonicalPath(candidate);
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(normalizedRoot + path.sep);
}

function sourceRepositoryRoot(cwd) {
  return gitChecked(cwd, ["rev-parse", "--show-toplevel"]).stdout.trim();
}

function sourceCommit(cwd, revision) {
  return gitChecked(cwd, ["rev-parse", "--verify", `${revision}^{commit}`]).stdout.trim();
}

function createReviewParent() {
  return fs.mkdtempSync(path.join(os.tmpdir(), REVIEW_TEMP_PREFIX));
}

function hooksPath(parent) {
  // The path intentionally does not exist. Keeping it outside the checkout
  // means the isolated parent contains one directory only.
  return path.join(parent, "hooks-disabled");
}

function cloneAtHead(sourceRoot, parent, headCommit) {
  const checkout = path.join(parent, CHECKOUT_NAME);
  const disabledHooks = hooksPath(parent);
  gitChecked(sourceRoot, ["-c", `core.hooksPath=${disabledHooks}`, "-c", "core.autocrlf=false", "clone", "--no-hardlinks", "--no-checkout", sourceRoot, checkout], {
    maxBuffer: DIFF_MAX_BUFFER
  });
  gitChecked(checkout, ["-c", `core.hooksPath=${disabledHooks}`, "config", "core.autocrlf", "false"]);
  gitChecked(checkout, ["-c", `core.hooksPath=${disabledHooks}`, "config", "core.logAllRefUpdates", "false"]);
  gitChecked(checkout, ["-c", `core.hooksPath=${disabledHooks}`, "remote", "remove", "origin"]);
  gitChecked(checkout, ["-c", `core.hooksPath=${disabledHooks}`, "reflog", "expire", "--expire=now", "--all"]);
  gitChecked(checkout, ["-c", `core.hooksPath=${disabledHooks}`, "checkout", "--detach", headCommit], {
    maxBuffer: DIFF_MAX_BUFFER
  });
  gitChecked(checkout, ["-c", `core.hooksPath=${disabledHooks}`, "config", "core.hooksPath", disabledHooks]);
  return checkout;
}

function applyWorkingTreeDiff(sourceRoot, checkout, parent) {
  const diff = gitChecked(sourceRoot, ["diff", "--binary", "--no-ext-diff", "HEAD"], {
    maxBuffer: DIFF_MAX_BUFFER
  }).stdout;
  if (!diff) {
    return;
  }

  const disabledHooks = hooksPath(parent);
  gitChecked(checkout, ["-c", `core.hooksPath=${disabledHooks}`, "apply", "--binary", "--whitespace=nowarn", "-"], {
    input: diff,
    maxBuffer: DIFF_MAX_BUFFER
  });
}

function removeExisting(destination) {
  try {
    fs.rmSync(destination, { recursive: true, force: true });
  } catch (error) {
    throw new Error(`Unable to replace snapshot path ${destination}: ${error.message}`);
  }
}

function ensureDestinationWithinCheckout(checkout, relativePath) {
  if (path.isAbsolute(relativePath)) {
    throw new Error(`Untracked path is absolute and cannot be copied safely: ${relativePath}`);
  }
  const destination = path.resolve(checkout, relativePath);
  if (!isWithin(checkout, destination)) {
    throw new Error(`Untracked path escapes the isolated checkout: ${relativePath}`);
  }
  return destination;
}

function ensureExistingPathWithin(root, candidate, description) {
  let existing = candidate;
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) {
      break;
    }
    existing = parent;
  }
  if (!isWithin(root, fs.realpathSync.native(existing))) {
    throw new Error(description);
  }
}

function safeSymlinkTarget(sourcePath, sourceRoot) {
  const linkTarget = fs.readlinkSync(sourcePath);
  const resolvedTarget = path.resolve(path.dirname(sourcePath), linkTarget);
  if (!isWithin(sourceRoot, resolvedTarget)) {
    throw new Error(`Untracked symlink escapes the repository and was rejected: ${path.relative(sourceRoot, sourcePath)}`);
  }

  // A symlink may point through another symlink. Resolve it when possible so
  // an apparently local link cannot expose a path outside the source root.
  try {
    if (!isWithin(sourceRoot, fs.realpathSync.native(resolvedTarget))) {
      throw new Error(`Untracked symlink escapes the repository and was rejected: ${path.relative(sourceRoot, sourcePath)}`);
    }
  } catch (error) {
    if (error.code !== "ENOENT" && error.code !== "ENOTDIR") {
      throw error;
    }
  }

  if (path.isAbsolute(linkTarget)) {
    const relativeTarget = path.relative(path.dirname(sourcePath), resolvedTarget);
    return relativeTarget || ".";
  }
  return linkTarget;
}

function copyUntrackedFile(sourceRoot, checkout, relativePath) {
  const sourcePath = path.resolve(sourceRoot, relativePath);
  if (!isWithin(sourceRoot, sourcePath)) {
    throw new Error(`Untracked path escapes the source repository: ${relativePath}`);
  }
  const destination = ensureDestinationWithinCheckout(checkout, relativePath);
  ensureExistingPathWithin(sourceRoot, sourcePath, `Untracked path escapes the source repository: ${relativePath}`);
  ensureExistingPathWithin(checkout, destination, `Untracked path would escape the isolated checkout: ${relativePath}`);
  const stat = fs.lstatSync(sourcePath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });

  if (stat.isSymbolicLink()) {
    const target = safeSymlinkTarget(sourcePath, sourceRoot);
    removeExisting(destination);
    fs.symlinkSync(target, destination, process.platform === "win32" ? "file" : undefined);
    return;
  }

  if (!stat.isFile()) {
    // Git reports untracked directories (not their contents) for nested
    // repositories and other special cases. There is no file content to copy.
    return;
  }

  removeExisting(destination);
  fs.copyFileSync(sourcePath, destination);
  try {
    fs.chmodSync(destination, stat.mode);
  } catch {
    // chmod is best effort on filesystems that do not expose POSIX modes.
  }
}

function copyNonIgnoredUntrackedFiles(sourceRoot, checkout) {
  const output = gitChecked(sourceRoot, ["ls-files", "--others", "--exclude-standard", "-z"]).stdout;
  for (const relativePath of parseNullSeparated(output)) {
    copyUntrackedFile(sourceRoot, checkout, relativePath);
  }
}

function validateCleanupParent(parent) {
  const tempRoot = path.resolve(os.tmpdir());
  const resolvedParent = path.resolve(parent);
  if (path.dirname(resolvedParent) !== tempRoot || !path.basename(resolvedParent).startsWith(REVIEW_TEMP_PREFIX)) {
    throw new Error(`Refusing to clean an unexpected review workspace path: ${parent}`);
  }
  const stat = fs.lstatSync(resolvedParent);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Refusing to clean a review workspace that is no longer a directory: ${parent}`);
  }
  return resolvedParent;
}

function makeCleanup(parent) {
  let cleaned = false;
  return () => {
    if (cleaned) {
      return;
    }
    const validatedParent = validateCleanupParent(parent);
    fs.rmSync(validatedParent, { recursive: true, force: true });
    cleaned = true;
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizePrefix(value) {
  return path.resolve(value).replace(/[\\/]+$/, "");
}

/**
 * Replace absolute snapshot/source paths in review output with repository-relative paths.
 * Both roots are accepted because a reviewer can report either checkout path.
 */
export function normalizeReviewPaths(text, snapshotRoot, originalRoot = null) {
  if (typeof text !== "string" || !text) {
    return text;
  }

  const roots = [...new Set([snapshotRoot, originalRoot].filter(Boolean).map(normalizePrefix))];
  if (roots.length === 0) {
    return text;
  }

  const variants = roots.flatMap((root) => {
    const slash = root.replaceAll("\\", "/");
    const backslash = root.replaceAll("/", "\\");
    return [root, slash, backslash];
  });
  const expression = variants.sort((a, b) => b.length - a.length).map(escapeRegExp).join("|");
  const windowsInsensitive = process.platform === "win32" ? "i" : "";
  const prefixPattern = new RegExp(`(?:${expression})(?:[\\\\/]+)?([^\\s\\r\\n\\]}>\\),\\\"']*)?`, `g${windowsInsensitive}`);
  return text.replace(prefixPattern, (_match, tail = "") => tail.replaceAll("\\", "/"));
}

/**
 * Create a disposable, review-only checkout without changing the source repository.
 */
export function prepareReviewWorkspace(cwd, target) {
  const sourceRoot = sourceRepositoryRoot(cwd);
  const headCommit = sourceCommit(sourceRoot, "HEAD");
  if (target.mode !== "working-tree" && target.mode !== "branch") {
    throw new Error("Unsupported review target mode: " + target.mode);
  }
  const baseCommit = target.mode === "branch" ? sourceCommit(sourceRoot, target.baseRef) : null;
  const parent = createReviewParent();
  const cleanup = makeCleanup(parent);

  try {
    const checkout = cloneAtHead(sourceRoot, parent, headCommit);
    let adjustedTarget = { ...target };

    if (target.mode === "branch") {
      adjustedTarget = {
        ...target,
        baseRef: baseCommit,
        sourceBaseRef: target.baseRef
      };
    } else if (target.mode === "working-tree") {
      applyWorkingTreeDiff(sourceRoot, checkout, parent);
      copyNonIgnoredUntrackedFiles(sourceRoot, checkout);
    } else {
      throw new Error(`Unsupported review target mode: ${target.mode}`);
    }

    return {
      cwd: checkout,
      target: adjustedTarget,
      cleanup
    };
  } catch (error) {
    try {
      cleanup();
    } catch {
      // Preserve the actionable preparation error; cleanup remains guarded.
    }
    throw error;
  }
}
