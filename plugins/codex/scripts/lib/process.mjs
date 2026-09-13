import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";

export const CODEX_BINARY_ENV = "CODEX_COMPANION_CODEX_BIN";

function isWslEnvironment(env) {
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) {
    return true;
  }
  if (process.platform !== "linux") {
    return false;
  }
  try {
    return /microsoft/i.test(fs.readFileSync("/proc/sys/kernel/osrelease", "utf8"));
  } catch {
    return /microsoft/i.test(os.release());
  }
}

function isUsableFile(filePath, platform = process.platform) {
  try {
    if (!fs.statSync(filePath).isFile()) {
      return false;
    }
    if (platform !== "win32") {
      fs.accessSync(filePath, fs.constants.X_OK);
    }
    return true;
  } catch {
    return false;
  }
}

function pathEntries(env, wsl) {
  const value = env.PATH ?? env.Path ?? "";
  return value.split(wsl ? ":" : path.delimiter).filter(Boolean);
}

function codexCandidates(env, wsl) {
  const names = process.platform === "win32" && !wsl
    ? ["codex.exe", "codex.cmd", "codex.bat", "codex"]
    : ["codex"];
  const candidates = [];
  for (const entry of pathEntries(env, wsl)) {
    for (const name of names) {
      const candidate = path.join(entry, name);
      if (isUsableFile(candidate, wsl ? "linux" : process.platform)) {
        candidates.push(candidate);
        break;
      }
    }
  }
  return candidates;
}

/**
 * Resolve the Codex executable without allowing an inherited Windows npm shim
 * to shadow a native WSL installation.
 */
export function resolveCodexBinary(env = process.env) {
  const explicit = env[CODEX_BINARY_ENV]?.trim();
  if (explicit) {
    return explicit;
  }

  const wsl = isWslEnvironment(env);
  const candidates = codexCandidates(env, wsl);
  if (wsl) {
    const nativePathCandidate = candidates.find((candidate) => !/^\/mnt\/[a-z]\//i.test(candidate));
    if (nativePathCandidate) {
      return nativePathCandidate;
    }

    const homeDir = env.HOME || os.homedir();
    const nativeHomeCandidate = path.join(homeDir, ".local", "bin", "codex");
    if (isUsableFile(nativeHomeCandidate, "linux")) {
      return nativeHomeCandidate;
    }
  }

  return candidates[0] ?? "codex";
}

export function codexBinaryRequiresShell(command, platform = process.platform) {
  return platform === "win32" && (command === "codex" || /\.(?:cmd|bat)$/i.test(command));
}

export function runCommand(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    maxBuffer: options.maxBuffer,
    timeout: options.timeoutMs ?? 120000,
    stdio: options.stdio ?? "pipe",
    shell: options.shell ?? (process.platform === "win32"),
    windowsHide: true
  });

  return {
    command,
    args,
    status: result.status ?? 0,
    signal: result.signal ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ?? null
  };
}

export function runCommandChecked(command, args = [], options = {}) {
  const result = runCommand(command, args, options);
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return result;
}

export function binaryAvailable(command, versionArgs = ["--version"], options = {}) {
  const resolvedCommand = command === "codex" ? resolveCodexBinary(options.env ?? process.env) : command;
  const isCodexCommand = command === "codex" || /^codex(?:\.(?:exe|cmd|bat))?$/i.test(path.basename(command));
  const shell = isCodexCommand
    ? (options.shell ?? codexBinaryRequiresShell(resolvedCommand))
    : options.shell;
  const result = runCommand(resolvedCommand, versionArgs, { timeoutMs: 15000, ...options, shell });
  if (result.error && /** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOENT") {
    return { available: false, detail: "not found" };
  }
  if (result.error) {
    return { available: false, detail: result.error.message };
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
    return { available: false, detail };
  }
  return { available: true, detail: result.stdout.trim() || result.stderr.trim() || "ok" };
}

function looksLikeMissingProcessMessage(text) {
  return /not found|no running instance|cannot find|does not exist|no such process/i.test(text);
}

export function terminateProcessTree(pid, options = {}) {
  if (!Number.isFinite(pid)) {
    return { attempted: false, delivered: false, method: null };
  }

  const platform = options.platform ?? process.platform;
  const runCommandImpl = options.runCommandImpl ?? runCommand;
  const killImpl = options.killImpl ?? process.kill.bind(process);

  if (platform === "win32") {
    const result = runCommandImpl("taskkill", ["/PID", String(pid), "/T", "/F"], {
      cwd: options.cwd,
      env: options.env
    });

    if (!result.error && result.status === 0) {
      return { attempted: true, delivered: true, method: "taskkill", result };
    }

    const combinedOutput = `${result.stderr}\n${result.stdout}`.trim();
    if (!result.error && looksLikeMissingProcessMessage(combinedOutput)) {
      return { attempted: true, delivered: false, method: "taskkill", result };
    }

    if (result.error?.code === "ENOENT") {
      try {
        killImpl(pid);
        return { attempted: true, delivered: true, method: "kill" };
      } catch (error) {
        if (error?.code === "ESRCH") {
          return { attempted: true, delivered: false, method: "kill" };
        }
        throw error;
      }
    }

    if (result.error) {
      throw result.error;
    }

    throw new Error(formatCommandFailure(result));
  }

  try {
    killImpl(-pid, "SIGTERM");
    return { attempted: true, delivered: true, method: "process-group" };
  } catch (error) {
    if (error?.code !== "ESRCH") {
      try {
        killImpl(pid, "SIGTERM");
        return { attempted: true, delivered: true, method: "process" };
      } catch (innerError) {
        if (innerError?.code === "ESRCH") {
          return { attempted: true, delivered: false, method: "process" };
        }
        throw innerError;
      }
    }

    return { attempted: true, delivered: false, method: "process-group" };
  }
}

export function formatCommandFailure(result) {
  const parts = [`${result.command} ${result.args.join(" ")}`.trim()];
  if (result.signal) {
    parts.push(`signal=${result.signal}`);
  } else {
    parts.push(`exit=${result.status}`);
  }
  const stderr = (result.stderr || "").trim();
  const stdout = (result.stdout || "").trim();
  if (stderr) {
    parts.push(stderr);
  } else if (stdout) {
    parts.push(stdout);
  }
  return parts.join(": ");
}
