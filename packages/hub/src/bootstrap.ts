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

export interface SingletonLock {
  release: () => void;
}

/**
 * Single-instance guard: at most one hub per state dir. Creates `lockPath`
 * atomically (O_EXCL) and stamps our pid into it.
 *
 * - Returns a handle on success — caller must `release()` on shutdown.
 * - Returns `null` when a *live* process already holds the lock (defer to it).
 * - Steals the lock when the recorded holder is dead (crashed hub).
 *
 * The lock lives in the per-HOME state dir, so test runs (which override HOME)
 * never collide with a real hub's `~/.agmux/hub.lock`.
 */
export function acquireSingletonLock(lockPath: string): SingletonLock | null {
  const deadline = Date.now() + 2000;
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, "wx"); // O_CREAT | O_EXCL | O_WRONLY
      fs.writeSync(fd, String(process.pid) + "\n");
      fs.closeSync(fd);
      let released = false;
      return {
        release: () => {
          if (released) return;
          released = true;
          try {
            // Only unlink if we still own it — never delete a successor's lock.
            if (readPidFile(lockPath) === process.pid) fs.unlinkSync(lockPath);
          } catch {}
        },
      };
    } catch (e: any) {
      if (e?.code !== "EEXIST") throw e;
      const holder = readPidFile(lockPath);
      if (holder === null) {
        // Lock file exists but no readable pid yet: the creator is mid-acquire,
        // or it died between create and write. Wait briefly, then treat as stale.
        if (Date.now() >= deadline) {
          try { fs.unlinkSync(lockPath); } catch {}
          continue;
        }
        Bun.sleepSync(20);
        continue;
      }
      if (holder !== process.pid && isProcessAlive(holder)) return null; // a live hub owns it
      // Stale (dead holder) or somehow our own — steal and retry the atomic create.
      try { fs.unlinkSync(lockPath); } catch {}
    }
  }
}
