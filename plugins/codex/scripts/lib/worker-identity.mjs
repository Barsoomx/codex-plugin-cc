import fs from "node:fs";

export function readProcessIdentity(pid) {
  if (process.platform !== "linux" || !Number.isInteger(pid) || pid <= 0) {
    return null;
  }

  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const closingParen = stat.lastIndexOf(")");
    if (closingParen < 0) {
      return null;
    }
    const fieldsAfterCommand = stat.slice(closingParen + 1).trim().split(/\s+/);
    const startTime = fieldsAfterCommand[19];
    const bootId = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    if (!startTime || !bootId) {
      return null;
    }
    return { bootId, startTime };
  } catch {
    return null;
  }
}
