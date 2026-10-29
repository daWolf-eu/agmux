// Mac side of `agmux run --remote R --sandbox S` (spec §5.1): start the agent
// through the sandbox's own agmux (`run --direct --print-coords`, or
// `run --headless`) over the openshell transport, then wait for its row to
// replicate and open it with the Phase 2 remote attach. Every value reaches
// the sandbox as its own argv element; nothing is shell-joined.
import {
  AGMUX_VERSION, parsePrintedCoords, sanitizeRemoteText,
  type HostRow, type RemoteTmux, type SessionRow,
} from "@agmux/protocol";
import {
  openshellControl, openshellTransport, runCapture, transportArgv,
  type RemoteConfig, type RemoteLaunch, type SandboxControl,
} from "@agmux/hub";
import { resolvePlacement, type AttachCtx, type AttachRequest, type Handoff } from "@agmux/tui";
import type { ParsedRun, RemoteTarget } from "./parse-run.ts";
import { attachCtxFor, settingsOrDefaults, type AttachSettings } from "./attach-place.ts";
import { attachRemote, defaultAttachRemoteDeps, defaultRemotes } from "./attach-remote.ts";

export type RemoteRun = Extract<ParsedRun, { kind: "profile" | "inline" | "remote-default" }> & { remote: RemoteTarget };

export function isRemoteRun(p: ParsedRun): p is RemoteRun {
  return p.kind !== "error" && p.remote !== undefined;
}

export const SANDBOX_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
export const WAIT_TIMEOUT_MS = 15_000;
export const WAIT_POLL_MS = 500;
const EXEC_TIMEOUT_MS = 60_000;

// CLI launch flags win over the [[remote]] launch keys. `--kind K` alone keeps
// the configured launch when it is that kind, else runs K's bare binary.
export function resolveRemoteLaunch(parsed: RemoteRun, remote: RemoteConfig): RemoteLaunch | { error: string } {
  if (parsed.kind === "profile") return { kind: null, profile: parsed.profileName, command: null, args: [] };
  if (parsed.kind === "inline") return { kind: parsed.agent_kind, profile: null, command: parsed.command, args: parsed.args };
  const cfg = remote.launch;
  if (parsed.agent_kind) {
    return cfg && cfg.profile === null && cfg.kind === parsed.agent_kind
      ? cfg : { kind: parsed.agent_kind, profile: null, command: null, args: [] };
  }
  if (cfg) return cfg;
  return { error: `agmux run --remote: no agent configured for remote ${remote.name} (set kind/profile in [[remote]] or pass --kind/-p)` };
}

function launchArgv(l: RemoteLaunch): string[] {
  if (l.profile !== null) return ["-p", l.profile];
  if (l.kind === null) throw new Error("remote launch has neither profile nor kind");
  return ["--kind", l.kind, "--", l.command ?? l.kind, ...l.args];
}

// The sandbox-side `agmux run` (contract: run --direct --print-coords, Task 5).
// cwd null = the remote's workdir, if any.
export function sandboxRunArgv(
  remote: RemoteConfig, launch: RemoteLaunch, o: { cwd: string | null; prompt?: string; headless: boolean },
): string[] {
  const cwd = o.cwd ?? remote.workdir;
  return [
    remote.agmux_bin, "run",
    ...(o.headless ? ["--headless"] : ["--direct", "--print-coords"]),
    ...(cwd !== null ? ["--cwd", cwd] : []),
    ...(o.prompt !== undefined ? ["--prompt", o.prompt] : []),
    ...launchArgv(launch),
  ];
}

// Poll the local hub until a row of `host` satisfies `match`; null on timeout.
// Hub errors count as "not yet".
export async function waitForRemoteRow(o: {
  hubUrl: string; fetchImpl: typeof fetch; host: string; match: (r: SessionRow) => boolean;
  timeoutMs: number; pollMs: number; now: () => number; sleep: (ms: number) => Promise<void>;
}): Promise<SessionRow | null> {
  const deadline = o.now() + o.timeoutMs;
  const url = `${o.hubUrl}/sessions?all=1&limit=1000&host=${encodeURIComponent(o.host)}`;
  for (;;) {
    try {
      const r = await o.fetchImpl(url);
      if (r.ok) {
        const { sessions } = (await r.json()) as { sessions: SessionRow[] };
        const hit = sessions.find((s) => s.host === o.host && o.match(s));
        if (hit) return hit;
      }
    } catch { /* hub hiccup: poll again */ }
    if (o.now() >= deadline) return null;
    await o.sleep(o.pollMs);
  }
}

// R3: pane + window always; the tmux server only when the sandbox printed one.
export function matchesPrinted(printed: RemoteTmux): (r: SessionRow) => boolean {
  return (r) => {
    const t = r.remote_tmux;
    if (!t || t.pane !== printed.pane || t.window !== printed.window) return false;
    return printed.server == null || t.server === printed.server;
  };
}

export interface SandboxExecResult { code: number; stdout: string; stderr: string }

export interface RunRemoteOpts {
  parsed: RemoteRun;
  prompt?: string;  // --prompt text, or the --prompt-file contents read on the Mac
  hubUrl: string;
  env: Record<string, string | undefined>;
  settings?: AttachSettings;  // wins over loadSettings
  loadSettings?: () => AttachSettings;  // read only when attaching; broken config → defaults
}

export interface RunRemoteDeps {
  remotes: () => RemoteConfig[];
  fetchImpl: typeof fetch;
  control: SandboxControl;
  exec: (argv: string[]) => Promise<SandboxExecResult>;  // stdin ignored, output captured
  execInherit: (argv: string[]) => Promise<number>;      // stdin ignored, output inherited
  attachRemote: (row: SessionRow, req: AttachRequest | undefined, env: { ctx: AttachCtx; settings: AttachSettings }) => Promise<Handoff | null>;
  runHandoff: (h: Handoff) => Promise<number>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  out: (s: string) => void;
  err: (s: string) => void;
}

// `exec --no-tty` starts the remote command only at local stdin EOF (R19).
export async function execCapture(argv: string[]): Promise<SandboxExecResult> {
  const p = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; p.kill("SIGKILL"); }, EXEC_TIMEOUT_MS);
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return timedOut ? { code: 1, stdout, stderr: `timed out after ${EXEC_TIMEOUT_MS / 1000} s` } : { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

export const defaultRunRemoteDeps: RunRemoteDeps = {
  remotes: defaultRemotes,
  fetchImpl: fetch,
  control: openshellControl(runCapture),
  exec: execCapture,
  execInherit: async (argv) => Bun.spawn(argv, { stdin: "ignore", stdout: "inherit", stderr: "inherit" }).exited,
  attachRemote: (row, req, env) => attachRemote(row, req, env, defaultAttachRemoteDeps),
  runHandoff: async (h) => {
    const child = Bun.spawn(h.argv, { stdio: ["inherit", "inherit", "inherit"], env: h.env ?? process.env });
    await child.exited;
    return child.exitCode ?? 0;
  },
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  out: (s) => console.log(s),
  err: (s) => console.error(s),
};

export function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function oldAgmux(host: string): string {
  return `${host} runs an older agmux; restage the image (stage-agmux)`;
}

// The hub's row for `host`; undefined when it has none. Throws when the hub fails.
export async function fetchHostRow(hubUrl: string, fetchImpl: typeof fetch, host: string): Promise<HostRow | undefined> {
  const r = await fetchImpl(`${hubUrl}/hosts`);
  if (!r.ok) throw new Error(`hub error ${r.status}`);
  return ((await r.json()) as { hosts: HostRow[] }).hosts.find((h) => h.host === host);
}

// The host row's agmux version, when the hub has synced this sandbox before.
async function hostVersion(o: RunRemoteOpts, deps: RunRemoteDeps, host: string): Promise<string | null> {
  try { return (await fetchHostRow(o.hubUrl, deps.fetchImpl, host))?.agmux_version ?? null; }
  catch { return null; }
}

// A just-started sandbox's follower may sit in backoff: reconnect it now.
export async function kickFollower(hubUrl: string, fetchImpl: typeof fetch, host: string): Promise<void> {
  try { await fetchImpl(`${hubUrl}/hosts/${encodeURIComponent(host)}/sync`, { method: "POST" }); }
  catch { /* the regular follower schedule still applies */ }
}

// The coords line a sandbox agmux printed last; null when there is none.
export function printedCoords(stdout: string): RemoteTmux | null {
  return parsePrintedCoords(stdout.split("\n").map((l) => l.trim()).filter((l) => l !== "").at(-1) ?? "");
}

// --new-* → that placement; no flag → the [attach.remote] default (undefined).
function attachRequest(p: RemoteRun): AttachRequest | undefined {
  const { placement } = p;
  return placement === "new-pane" || placement === "new-window" || placement === "new-session" ? { placement } : undefined;
}

type AttachPlan = { req: AttachRequest | undefined; env: { ctx: AttachCtx; settings: AttachSettings } };

export async function runRemote(o: RunRemoteOpts, deps: RunRemoteDeps): Promise<number> {
  const { parsed } = o;
  const { name, sandbox } = parsed.remote;
  if (!SANDBOX_NAME_RE.test(sandbox)) { deps.err("--sandbox must match [A-Za-z0-9._-]{1,64}"); return 2; }

  let remotes: RemoteConfig[];
  try { remotes = deps.remotes(); } catch (e) { deps.err(`agmux run --remote: ${message(e)}`); return 2; }
  const remote = remotes.find((r) => r.name === name);
  if (!remote) {
    const names = remotes.map((r) => r.name).join(", ") || "none";
    deps.err(`agmux run --remote: unknown remote "${name}" (configured: ${names})`);
    return 2;
  }
  const launch = resolveRemoteLaunch(parsed, remote);
  if ("error" in launch) { deps.err(launch.error); return 2; }

  const headless = parsed.placement === "headless";
  const attaching = !headless && !parsed.detach;
  // Check the local placement before anything starts in the sandbox.
  let plan: AttachPlan | null = null;
  if (attaching) {
    const settings = o.settings ?? settingsOrDefaults(o.loadSettings);
    const ctx = attachCtxFor(settings, o.env, false);
    const req = attachRequest(parsed);
    try { resolvePlacement("remote", ctx, req?.placement, { remote: settings.remote.placement }); }
    catch (e) { deps.err(`agmux run: ${message(e)}`); return 2; }
    plan = { req, env: { ctx, settings } };
  }

  const spec = openshellTransport(remote).spec(sandbox);
  const status = await deps.control.status(spec);
  if (status.state === "missing") {
    deps.err(`agmux run: sandbox ${sandbox} not found on remote ${name} (gateway ${remote.gateway})`);
    if (status.detail) deps.err(`agmux: ${status.detail}`);
    return 2;
  }
  if (status.state === "stopped") {
    try { await deps.control.start(spec); }
    catch (e) { deps.err(`agmux run: cannot start sandbox ${sandbox}: ${sanitizeRemoteText(message(e))}`); return 1; }
  }

  // After status: a deleted sandbox's stale host row must not report a version skew.
  const host = `${remote.gateway}/${sandbox}`;
  const version = await hostVersion(o, deps, host);
  if (version !== null && version !== AGMUX_VERSION) { deps.err(oldAgmux(host)); return 2; }

  const cmd = sandboxRunArgv(remote, launch, { cwd: parsed.cwd ?? null, prompt: o.prompt, headless });
  const argv = transportArgv(spec, cmd, { tty: false });
  if (headless) return deps.execInherit(argv);

  const res = await deps.exec(argv);
  const stderr = sanitizeRemoteText(res.stderr);
  if (res.code !== 0) {
    // An agmux without the remote-run flags takes the first one for the command.
    if (res.code === 2 && /cannot infer agent_kind from '--(direct|print-coords)'/.test(res.stderr)) { deps.err(oldAgmux(host)); return 2; }
    deps.err(`agmux run: ${host}: ${stderr || `exited ${res.code}`}`);
    return res.code;
  }
  const printed = printedCoords(res.stdout);
  if (!printed) { deps.err(`agmux run: ${host} printed no coordinates${stderr ? `: ${stderr}` : ""}`); return 1; }

  if (!plan) { deps.out(`agmux: started on ${host} (${printed.session}:${printed.window})`); return 0; }

  await kickFollower(o.hubUrl, deps.fetchImpl, host);
  const row = await waitForRemoteRow({
    hubUrl: o.hubUrl, fetchImpl: deps.fetchImpl, host, match: matchesPrinted(printed),
    timeoutMs: WAIT_TIMEOUT_MS, pollMs: WAIT_POLL_MS, now: deps.now, sleep: deps.sleep,
  });
  if (!row) { deps.err(`agmux: started, but the session has not replicated yet; run agmux ls --host ${host}`); return 1; }

  let h: Handoff | null;
  try { h = await deps.attachRemote(row, plan.req, plan.env); }
  catch (e) { deps.err(`agmux run: attach: ${message(e)}`); return 2; }
  if (!h || h.argv.length === 0) return 0;
  return deps.runHandoff(h);
}
