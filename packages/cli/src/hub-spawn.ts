import * as fs from "node:fs";
import * as path from "node:path";
import { isProcessAlive, readPortFile, readPidFile } from "@agmux/hub";

async function ping(url: string, timeoutMs = 500): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const r = await fetch(`${url}/health`, { signal: ctrl.signal });
    clearTimeout(t);
    return r.ok;
  } catch { return false; }
}

export async function discoverLiveHub(stateDir: string): Promise<string | null> {
  const port = readPortFile(path.join(stateDir, "hub.port"));
  const pid = readPidFile(path.join(stateDir, "hub.pid"));
  if (!port || !pid) return null;
  if (!isProcessAlive(pid)) return null;
  const url = `http://127.0.0.1:${port}`;
  return (await ping(url)) ? url : null;
}

export async function ensureHubRunning(stateDir: string, hubBin: string): Promise<string> {
  const existing = await discoverLiveHub(stateDir);
  if (existing) return existing;
  // Race-safe: spawn detached, wait up to 5s for port file + /health.
  fs.mkdirSync(stateDir, { recursive: true });
  Bun.spawn([hubBin], { stdio: ["ignore", "ignore", "ignore"], cwd: stateDir }).unref();
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const url = await discoverLiveHub(stateDir);
    if (url) return url;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("agmux: failed to spawn hub within 5s");
}
