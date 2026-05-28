import * as fs from "node:fs";

export function atomicWritePortFile(filePath: string, port: number): void {
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, String(port) + "\n");
  fs.renameSync(tmp, filePath);
}

export function readPortFile(filePath: string): number | null {
  if (!fs.existsSync(filePath)) return null;
  const v = Number(fs.readFileSync(filePath, "utf8").trim());
  return Number.isInteger(v) && v > 0 ? v : null;
}

export function writePidFile(filePath: string, pid: number): void {
  fs.writeFileSync(filePath, String(pid) + "\n");
}

export function readPidFile(filePath: string): number | null {
  if (!fs.existsSync(filePath)) return null;
  const v = Number(fs.readFileSync(filePath, "utf8").trim());
  return Number.isInteger(v) && v > 0 ? v : null;
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e.code === "EPERM"; // exists but we can't signal it
  }
}
