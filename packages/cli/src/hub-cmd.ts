import * as path from "node:path";
import { readPortFile, readPidFile, isProcessAlive } from "@agmux/hub";
import { AGMUX_VERSION } from "@agmux/protocol";
import { ensureHubRunning } from "./hub-spawn.ts";

// `agmux hub status|restart` — explicit, no automatic behavior. The hub is a
// long-running daemon; a freshly installed binary does not supersede a live
// older one on its own (ensureHubRunning reuses any healthy hub). `status` shows
// the running version vs the installed one; `restart` gracefully rolls it.
export interface HubCmdDeps {
  stateDir: string;
  hubBin: string;
  out: (s: string) => void;
  selfVersion?: string;
  // injectables (default to real impls); kept on the interface for testability.
  readPid?: (stateDir: string) => number | null;
  readPort?: (stateDir: string) => number | null;
  isAlive?: (pid: number) => boolean;
  kill?: (pid: number, sig: NodeJS.Signals) => void;
  fetchImpl?: typeof fetch;
  ensureHub?: (stateDir: string, hubBin: string) => Promise<string>;
  sleep?: (ms: number) => Promise<void>;
  nowMs?: () => number;
}

async function runningVersion(port: number | null, fetchImpl: typeof fetch): Promise<string | null> {
  if (!port) return null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 500);
    const r = await fetchImpl(`http://127.0.0.1:${port}/health`, { signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) return null;
    const j = (await r.json()) as { version?: string };
    return j.version ?? null;
  } catch { return null; }
}

export async function runHubCmd(args: string[], deps: HubCmdDeps): Promise<number> {
  const sub = args[0];
  const self = deps.selfVersion ?? AGMUX_VERSION;
  const readPid = deps.readPid ?? ((s) => readPidFile(path.join(s, "hub.pid")));
  const readPort = deps.readPort ?? ((s) => readPortFile(path.join(s, "hub.port")));
  const isAlive = deps.isAlive ?? isProcessAlive;
  const kill = deps.kill ?? ((pid, sig) => { process.kill(pid, sig); });
  const fetchImpl = deps.fetchImpl ?? fetch;
  const ensureHub = deps.ensureHub ?? ensureHubRunning;
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const nowMs = deps.nowMs ?? (() => Date.now());

  if (sub === "status") {
    const pid = readPid(deps.stateDir);
    const port = readPort(deps.stateDir);
    if (!pid || !isAlive(pid)) {
      deps.out("hub: not running");
      deps.out(`installed: agmux ${self}`);
      return 0;
    }
    const ver = await runningVersion(port, fetchImpl);
    deps.out(`hub: running  pid ${pid}  port ${port ?? "?"}  version ${ver ?? "(unknown)"}`);
    deps.out(`installed: agmux ${self}`);
    if (ver && ver !== self) {
      deps.out(`note: running hub is version ${ver}; run 'agmux hub restart' to roll to ${self}`);
    }
    return 0;
  }

  if (sub === "restart") {
    const pid = readPid(deps.stateDir);
    if (pid && isAlive(pid)) {
      deps.out(`stopping hub (pid ${pid})…`);
      try { kill(pid, "SIGTERM"); } catch { /* already gone */ }
      const deadline = nowMs() + 3000;
      while (nowMs() < deadline && isAlive(pid)) await sleep(100);
      // Last resort if it ignored SIGTERM; the next hub steals the stale lock.
      if (isAlive(pid)) { try { kill(pid, "SIGKILL"); } catch { /* gone */ } await sleep(150); }
    }
    const url = await ensureHub(deps.stateDir, deps.hubBin);
    const newPid = readPid(deps.stateDir);
    const newPort = readPort(deps.stateDir);
    const ver = await runningVersion(newPort, fetchImpl);
    deps.out(`hub started: pid ${newPid ?? "?"}  port ${newPort ?? "?"}  version ${ver ?? "(unknown)"}  (${url})`);
    return 0;
  }

  deps.out("usage: agmux hub <status|restart>");
  return 2;
}
