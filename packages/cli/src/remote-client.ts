// Mac-side pane process for a remote (sandbox) session: `agmux attach <id>
// --remote-client --mode view|full --detach-key <k>`. Runs inside a local tmux
// pane, tags it, runs the fixed attach script in the sandbox in the foreground
// (`exec --tty`), and reaps the sandbox-side client on hangup or failure
// (`exec --no-tty`, stdin closed). See remote-tmux.ts for the scripts.
import { isRemoteTmux, LIVE_STATUSES, tmuxSocketArgs, tmuxSocketFromEnv, type HostRow, type RemoteAttachMode, type SessionRow } from "@agmux/protocol";
import { runCapture, transportArgv, transportControlArgv } from "@agmux/hub";
import { fullScriptArgv, reapScriptArgv, viewScriptArgv, viewSessionName } from "./remote-tmux.ts";

export interface RemoteClientOpts {
  sessionId: string; mode: RemoteAttachMode; detachKey: string; hubUrl: string;
  env: Record<string, string | undefined>;
}

export interface RemoteClientDeps {
  fetchImpl: typeof fetch;
  tmux(args: string[]): Promise<void>;
  capture(argv: string[], timeoutMs: number): Promise<string>;
  spawnTty(argv: string[]): { exited: Promise<number> };
  onSignal(sig: "SIGHUP" | "SIGTERM", fn: () => void): void;
  exit(code: number): never;
  rand(): string;
}

const CAPTURE_TIMEOUT_MS = 10_000;

export function tagFor(env: Record<string, string | undefined>, rand: () => string): string {
  const m = /^%(\d{1,9})$/.exec(env.TMUX_PANE ?? "");
  return m ? `p${m[1]}` : `t${rand()}`;
}

function randHex(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, "0")).join("");
}

export const defaultRemoteClientDeps: RemoteClientDeps = {
  fetchImpl: fetch,
  tmux: async (args) => {
    const p = Bun.spawn(["tmux", ...args], { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
    if ((await p.exited) !== 0) throw new Error(`tmux ${args[0]} failed`);
  },
  capture: (argv, timeoutMs) => runCapture(argv, { timeoutMs }),
  spawnTty: (argv) => ({ exited: Bun.spawn(argv, { stdin: "inherit", stdout: "inherit", stderr: "inherit" }).exited }),
  onSignal: (sig, fn) => { process.on(sig, fn); },
  exit: (code) => process.exit(code),
  rand: randHex,
};

async function getJson<T>(f: typeof fetch, url: string): Promise<T | string> {
  try {
    const r = await f(url);
    if (!r.ok) return `hub error ${r.status}`;
    return (await r.json()) as T;
  } catch (e) { return `hub unreachable: ${e instanceof Error ? e.message : String(e)}`; }
}

function fail(msg: string): number { console.error(`agmux: ${msg}`); return 1; }

export async function runRemoteClient(o: RemoteClientOpts, deps: RemoteClientDeps = defaultRemoteClientDeps): Promise<number> {
  const sr = await getJson<{ session: SessionRow }>(deps.fetchImpl, `${o.hubUrl}/sessions/${encodeURIComponent(o.sessionId)}`);
  if (typeof sr === "string") return fail(sr);
  const row = sr.session;
  if (!row.remote) return fail(`session ${o.sessionId.slice(0, 8)} is not a remote session`);
  if (!LIVE_STATUSES.includes(row.status)) return fail(`session ${o.sessionId.slice(0, 8)} is not live (${row.status})`);
  const coords = row.remote_tmux;
  if (!isRemoteTmux(coords)) return fail(`unsupported tmux coordinates from ${row.host}`);
  const hr = await getJson<{ hosts: HostRow[] }>(deps.fetchImpl, `${o.hubUrl}/hosts`);
  if (typeof hr === "string") return fail(hr);
  const spec = hr.hosts.find((h) => h.host === row.host)?.transport;
  if (!spec) return fail(`${row.host} has not synced yet`);

  const tag = tagFor(o.env, deps.rand);
  const pane = o.env.TMUX_PANE;
  if (/^%\d{1,9}$/.test(pane ?? "")) {
    const sock = tmuxSocketArgs(tmuxSocketFromEnv(o.env.TMUX));
    for (const [k, v] of [["@agmux_session_id", o.sessionId], ["@agmux_remote", "1"], ["@agmux_attach_mode", o.mode]] as const) {
      try { await deps.tmux([...sock, "set-option", "-p", "-t", pane!, k, v]); } catch { /* bookkeeping only */ }
    }
  }

  const reap = async (): Promise<void> => {
    try { await deps.capture(transportArgv(spec, reapScriptArgv(tag), { tty: false }), CAPTURE_TIMEOUT_MS); } catch { /* best effort */ }
  };
  let signalled = false;
  for (const [sig, code] of [["SIGHUP", 129], ["SIGTERM", 143]] as const) {
    deps.onSignal(sig, () => {
      if (signalled) return;
      signalled = true;
      void reap().then(() => deps.exit(code));
    });
  }

  // A failing `get` is ignored: the exec reports the real error.
  try {
    const info = JSON.parse(await deps.capture(transportControlArgv(spec, "get"), CAPTURE_TIMEOUT_MS)) as { phase?: unknown };
    if (info.phase === "Stopped") await deps.capture(transportControlArgv(spec, "start"), CAPTURE_TIMEOUT_MS * 6);
  } catch { /* see above */ }

  const script = o.mode === "full" ? fullScriptArgv(coords, tag) : viewScriptArgv(coords, viewSessionName(o.sessionId, tag), o.detachKey, tag);
  const code = await deps.spawnTty(transportArgv(spec, script, { tty: true })).exited;
  if (code !== 0 && !signalled) await reap();
  return code;
}
