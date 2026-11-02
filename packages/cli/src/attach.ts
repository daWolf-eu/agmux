import { $ } from "bun";
import type { RemoteAttachMode, SessionRow } from "@agmux/protocol";
import { LIVE_STATUSES, detectMux, rowMux, tmuxSocketArgs } from "@agmux/protocol";
import { defaultRexExec, type RexExec } from "@agmux/wrapper";
import { createDefaultRegistry, type Registry } from "@agmux/adapters";
import { buildRelaunchSpec } from "./relaunch.ts";
import { resolvePrefix } from "./id-resolve.ts";
import { loadProfileLaunch } from "./profile-env.ts";
import { hasSession } from "./tmux-place.ts";
import { resumeIntoSession } from "./resume-place.ts";
import { placementOps, type PlacementOps } from "./mux-ops.ts";
import { openRexRow, openTmuxTab, planOpen, probeRow, resumeTarget, rexUnreachableMessage } from "./open-row.ts";
import { postSeen, seenHost } from "./seen.ts";
import type { RemoteConfig } from "@agmux/hub";
import { attachKind, resolvePlacement } from "@agmux/tui";
import { attachCtxFor, settingsOrDefaults, type AttachSettings } from "./attach-place.ts";
import { attachRemote, defaultAttachRemoteDeps, defaultRemotes } from "./attach-remote.ts";
import { defaultResumeRemoteDeps, resumeRemote, type ResumeRemoteDeps } from "./resume-remote.ts";

export { settingsOrDefaults } from "./attach-place.ts";

export interface AttachOpts {
  idOrPrefix: string; hubUrl: string; wrapBin: string; registry?: Registry;
  settings?: AttachSettings; // [attach.remote] placement/mode for a remote row
  // Read only for a remote row (a local attach never reads config); a broken
  // config warns and falls back to the defaults. `settings` wins.
  loadSettings?: () => AttachSettings;
  mode?: RemoteAttachMode;   // --mode: overrides the remote mode default
  remotes?: () => RemoteConfig[]; // [[remote]] entries; default: config.toml
  resumeRemote?: Partial<ResumeRemoteDeps>; // closed remote row: sandbox IO (tests)
  sessionExists?: (name: string, socket: string | null) => Promise<boolean>; // default: tmux has-session (tests)
  rexExec?: RexExec;  // Rex commands (tests)
  ops?: PlacementOps; // the caller's placements; default: placementOps(process.env) (tests)
}

export interface AttachCoords { tmux_session: string; tmux_window: string; tmux_pane: string | null; tmux_socket: string | null; }

// Build the tmux invocation(s) that focus a session's pane.
//   inTmux  → switch the current client's window, then select the pane (two
//             independent commands; switch-client returns immediately).
//   !inTmux → one foreground `attach-session` that also selects window + pane,
//             chained with literal `;` separators (each its own argv element so
//             tmux treats it as a command separator — no shell escaping).
// Pane ids (`%N`) are server-global, so `select-pane -t %N` needs no qualifier.
// Without a stored pane we fall back to window-only (prior behavior).
export function buildAttachCommands(c: AttachCoords, inTmux: boolean): string[][] {
  const winTarget = `${c.tmux_session}:${c.tmux_window}`;
  const sock = tmuxSocketArgs(c.tmux_socket);
  if (inTmux) {
    const cmds: string[][] = [[...sock, "switch-client", "-t", winTarget]];
    if (c.tmux_pane) cmds.push([...sock, "select-pane", "-t", c.tmux_pane]);
    return cmds;
  }
  const argv = [...sock, "attach-session", "-t", c.tmux_session, ";", "select-window", "-t", winTarget];
  if (c.tmux_pane) argv.push(";", "select-pane", "-t", c.tmux_pane);
  return [argv];
}

// Decide whether a session can be re-focused in place (attach) or must be
// relaunched (resume). Session status is only a LAGGING approximation of tmux
// reality: a row can read LIVE (idle/running/waiting) while its tmux session is
// already gone — e.g. a native row pinned live by pid reuse (spec §8), a
// heartbeat not yet past the lost threshold, or the tmux server killed out from
// under us. So a LIVE row is attachable only if its tmux session actually still
// exists; otherwise we resume instead of running a doomed `tmux attach-session`
// (which throws an uncaught ShellError and crashes the command).
export async function decideAttach(
  session: Pick<SessionRow, "status" | "tmux_session" | "tmux_window" | "tmux_socket">,
  sessionExists: (name: string, socket: string | null) => Promise<boolean>,
): Promise<"attach" | "resume"> {
  const live = LIVE_STATUSES.includes(session.status) && !!session.tmux_session && !!session.tmux_window;
  if (!live) return "resume";
  if (!(await sessionExists(session.tmux_session!, session.tmux_socket))) return "resume";
  return "attach";
}

export async function attachCmd(opts: AttachOpts): Promise<number> {
  const listR = await fetch(`${opts.hubUrl}/sessions?all=1&limit=1000`);
  if (!listR.ok) { console.error(`hub error ${listR.status}`); return 1; }
  const { sessions } = (await listR.json()) as { sessions: SessionRow[] };
  const res = resolvePrefix(opts.idOrPrefix, sessions.map((s) => s.session_id));
  if (!res.ok) { console.error(res.error); return 2; }

  const r = await fetch(`${opts.hubUrl}/sessions/${res.id}`);
  const { session, usage } = (await r.json()) as {
    session: SessionRow;
    usage: { turn_count: number } | null;
  };

  const caller = detectMux(process.env);
  const inTmux = caller === "tmux";

  // Fire-and-forget: marking a session seen is bookkeeping, never a reason to
  // block or fail an attach. postSeen already resolves false rather than
  // throwing on failure; `.catch` here is defense-in-depth against ever
  // surfacing an unhandled rejection.
  void postSeen(session.session_id, "attach", {
    hubUrl: opts.hubUrl, host: seenHost(session),
    fetchImpl: fetch, now: () => new Date().toISOString(), newId: () => crypto.randomUUID(),
  }).catch(() => {});

  if (session.remote) return attachRemoteCmd(session, opts);

  const rexExec = opts.rexExec ?? defaultRexExec;
  const ops = opts.ops ?? placementOps(process.env, false, rexExec);
  // A closed row isn't probed: only a live one can be still running.
  const live = attachKind(session) === "live";
  const presence = live ? await probeRow(session, opts.sessionExists ?? hasSession, rexExec) : "gone";
  const plan = planOpen({ caller, row: rowMux(session), live, presence });

  if (plan === "unreachable") { console.error(rexUnreachableMessage(session.session_id)); return 2; }

  if (plan === "focus-rex" || plan === "tmux-tab") {
    try {
      const h = plan === "focus-rex"
        ? await openRexRow(session, { caller, popup: false, currentPane: ops.currentPane }, rexExec)
        : await openTmuxTab(session);
      if (h?.notice) console.log(h.notice);
      return 0;
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      return 2;
    }
  }

  if (plan === "tmux-native") {
    const cmds = buildAttachCommands(
      { tmux_session: session.tmux_session!, tmux_window: session.tmux_window!, tmux_pane: session.tmux_pane, tmux_socket: session.tmux_socket },
      inTmux,
    );
    // !inTmux yields a single foreground attach (inherit stdio so it takes the
    // terminal); inTmux yields quick non-blocking switch/select commands.
    for (const args of cmds) {
      if (inTmux) await $`tmux ${args}`.quiet();
      else await $`tmux ${args}`;
    }
    return 0;
  }

  // dead / lost / stale-live (pane gone): relaunch under the same session_id,
  // resuming natively if the adapter supports it (spec §6.4). buildRelaunchSpec
  // encapsulates the choice.
  const spec = buildRelaunchSpec(session, {
    hubUrl: opts.hubUrl,
    wrapBin: opts.wrapBin,
    registry: opts.registry ?? createDefaultRegistry(),
    baseEnv: process.env,
    // Zero observed turns (turn_count 0, or no usage row at all) → the adapter
    // watched the session but no turn ever happened, so no native conversation
    // was persisted and a resume would fail ("No conversation found"). A
    // native_session_id can only come from an attached adapter, so a missing
    // usage row safely means "watched, zero turns" — relaunch fresh.
    turnCount: usage?.turn_count ?? 0,
    loadProfileLaunch,
  });

  // In a multiplexer: place the resumed agent in a NEW window of the caller's
  // current session and switch to it (mirrors the dash resume flow), rather than
  // taking over the pane the user ran `attach` from. Outside one: hand the terminal
  // to the relaunched agent — the wrapper creates/attaches the tmux session itself.
  if (caller !== null) {
    const here = await ops.currentPane().catch(() => null);
    const target = resumeTarget(session, caller, here, process.env);
    const socket = here?.socket ?? null;
    await resumeIntoSession(spec, target, session.session_id.slice(0, 8), ops, socket);
    return 0;
  }

  const child = Bun.spawn(spec.wrapArgv, {
    stdio: ["inherit", "inherit", "inherit"],
    env: spec.env,
  });
  await child.exited;
  return child.exitCode ?? 0;
}

// A remote row: the [attach.remote] default placement, then the pane process
// in the foreground when it runs here (inline). A closed one is resumed in its
// sandbox first; its errors carry their own prefix.
async function attachRemoteCmd(session: SessionRow, opts: AttachOpts): Promise<number> {
  const settings = opts.settings ?? settingsOrDefaults(opts.loadSettings);
  const ctx = attachCtxFor(settings, process.env, false);
  const live = attachKind(session) === "remote";
  let h;
  try {
    const req = opts.mode
      ? { placement: resolvePlacement("remote", ctx, undefined, { remote: settings.remote.placement }), mode: opts.mode }
      : undefined;
    h = live
      ? await attachRemote(session, req, { ctx, settings }, defaultAttachRemoteDeps)
      : await resumeRemote(session, req, { ctx, settings, hubUrl: opts.hubUrl, remotes: opts.remotes ?? defaultRemotes },
        { ...defaultResumeRemoteDeps, fetchImpl: fetch, ...opts.resumeRemote });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(live ? `attach: ${msg}` : msg);
    return 2;
  }
  if (!h || h.argv.length === 0) return 0;
  const child = Bun.spawn(h.argv, { stdio: ["inherit", "inherit", "inherit"], env: h.env ?? process.env });
  await child.exited;
  return child.exitCode ?? 0;
}
