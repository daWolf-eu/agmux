import * as os from "node:os";
import * as path from "node:path";
import { readPortFile, readPidFile, isProcessAlive, loadRemotes } from "@agmux/hub";
import {
  AGMUX_CONFIG_SUBPATH, AGMUX_VERSION, REPLICATION_VERSION, sanitizeRemoteText as clean,
  type HostRow, type RemoteSyncState,
} from "@agmux/protocol";
import { syncAge } from "@agmux/tui";
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
  // Reads [[remote]] the way the hub does at start; throws on a broken config.
  loadRemotes?: () => unknown;
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

interface HostsReply { hosts: HostRow[]; remotes: RemoteSyncState[] }

// `remotes` is absent on an older hub.
async function fetchHosts(port: number | null, fetchImpl: typeof fetch): Promise<HostsReply> {
  const none: HostsReply = { hosts: [], remotes: [] };
  if (!port) return none;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 500);
    const r = await fetchImpl(`http://127.0.0.1:${port}/hosts`, { signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) return none;
    const j = (await r.json()) as Partial<HostsReply>;
    return { hosts: j.hosts ?? [], remotes: j.remotes ?? [] };
  } catch { return none; }
}

function configError(load: () => unknown): string | null {
  try { load(); return null; } catch (e) { return clean(e instanceof Error ? e.message : String(e)); }
}

function remoteLine(r: RemoteSyncState, now: number): string {
  if ("config_error" in r) return `remote sync disabled: ${clean(r.config_error)}`;
  let line = `remote ${clean(r.name)}  gateway ${clean(r.gateway)}  ${r.nodes} ${r.nodes === 1 ? "sandbox" : "sandboxes"}  last discovery ${syncAge(r.last_discovery_ts, now)}`;
  if (r.last_discovery_error) line += `  error: ${clean(r.last_discovery_error)}`;
  return line;
}

function hostLines(h: HostRow, now: number): string[] {
  const state = h.removed_ts ? "removed" : !h.last_sync_ok ? "stale" : "ok";
  const sync = syncAge(h.last_sync_ts, now);
  let line = `remote ${clean(h.remote)}  ${clean(h.host)}  ${state}  last sync ${sync}  agmux ${h.agmux_version == null ? "?" : clean(h.agmux_version)}  cursor ${h.cursor}`;
  if (h.rejected > 0) line += `  rejected ${h.rejected}`;
  if (state !== "ok" && h.last_error) line += `  error: ${clean(h.last_error)}`;
  const lines = [line];
  if (h.replication != null && h.replication > REPLICATION_VERSION) {
    lines.push(`note: ${clean(h.host)} runs a newer replication format (${h.replication}); update agmux`);
  }
  return lines;
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
  const load = deps.loadRemotes ?? (() => loadRemotes(path.join(os.homedir(), AGMUX_CONFIG_SUBPATH)));

  if (sub === "status") {
    const pid = readPid(deps.stateDir);
    const port = readPort(deps.stateDir);
    // The hub reads [[remote]] only at start and its stdio goes nowhere: check the file here too.
    const localError = configError(load);
    if (!pid || !isAlive(pid)) {
      deps.out("hub: not running");
      deps.out(`installed: agmux ${self}`);
      if (localError) deps.out(`remote sync disabled: ${localError}`);
      return 0;
    }
    const ver = await runningVersion(port, fetchImpl);
    deps.out(`hub: running  pid ${pid}  port ${port ?? "?"}  version ${ver ?? "(unknown)"}`);
    deps.out(`installed: agmux ${self}`);
    if (ver && ver !== self) {
      deps.out(`note: running hub is version ${ver}; run 'agmux hub restart' to roll to ${self}`);
    }
    const { hosts, remotes } = await fetchHosts(port, fetchImpl);
    for (const r of remotes) deps.out(remoteLine(r, nowMs()));
    if (localError && !remotes.some((r) => "config_error" in r)) {
      deps.out(`note: [[remote]] config is invalid; 'agmux hub restart' would disable sync: ${localError}`);
    }
    for (const h of hosts) {
      for (const l of hostLines(h, nowMs())) deps.out(l);
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
