import { AGMUX_HUB_URL_ENV, AGMUX_TMUX_SESSION_ENV, AGMUX_TMUX_SESSION_DEFAULT } from "@agmux/protocol";
import type { Placement } from "./parse-run.ts";
import {
  readCurrentPane, splitPane, newWindow, newSession, switchClient,
  type PaneCoords,
} from "./tmux-place.ts";

// Profile mode → wrapper loads the named profile from ~/.config/agmux/config.toml.
export interface RunProfileOpts {
  kind: "profile";
  profileName: string;
  hubUrl: string;
  wrapBin: string;
  placement: Placement;
  detach: boolean;
}

// Ad-hoc mode → CLI builds an inline-profile spec and passes it via env. Wrapper
// reads AGMUX_INLINE_PROFILE and skips the config-file lookup.
export interface RunInlineOpts {
  kind: "inline";
  agent_kind: "claude" | "codex";
  command: string;
  args: string[];
  hubUrl: string;
  wrapBin: string;
  placement: Placement;
  detach: boolean;
}

export type RunOpts = RunProfileOpts | RunInlineOpts;

interface WrapperSpawn {
  argv: string[];                 // argv to pass to the wrapper binary
  env: Record<string, string>;    // env vars to forward to the wrapper
  label: string;                  // short label for tmux window/pane names
}

function buildWrapperSpawn(opts: RunOpts): WrapperSpawn {
  const env: Record<string, string> = { [AGMUX_HUB_URL_ENV]: opts.hubUrl };
  if (opts.kind === "profile") {
    return { argv: [opts.profileName], env, label: opts.profileName };
  }
  const inlineProfile = {
    agent_kind: opts.agent_kind,
    command: opts.command,
    args: opts.args,
    env: {},
  };
  const label = opts.command.split("/").pop() ?? "agent";
  env.AGMUX_INLINE_PROFILE = JSON.stringify(inlineProfile);
  return { argv: [label], env, label };
}

async function runInherit(opts: RunOpts): Promise<number> {
  const spawn = buildWrapperSpawn(opts);
  const child = Bun.spawn([opts.wrapBin, ...spawn.argv], {
    stdio: ["inherit", "inherit", "inherit"],
    env: { ...process.env, ...spawn.env },
  });
  await child.exited;
  return child.exitCode ?? 0;
}

function shortRandomTag(): string {
  // Short tag for tmux session/window names — only needs to be unique-ish for
  // the lifetime of the agmux tmux session.
  return Math.random().toString(36).slice(2, 8);
}

// Pick the tmux session for --new-window:
//   1. AGMUX_TMUX_SESSION env var (explicit override) wins, since users who set
//      it want all agmux windows to live in a known place.
//   2. The caller's current tmux session (most ergonomic — new window appears
//      right next to where you're working).
//   3. AGMUX_TMUX_SESSION_DEFAULT ("agmux") as the no-tmux fallback.
function pickWindowTargetSession(here: PaneCoords | null): string {
  const override = process.env[AGMUX_TMUX_SESSION_ENV];
  if (override) return override;
  if (here) return here.session;
  return AGMUX_TMUX_SESSION_DEFAULT;
}

async function runWithPlacement(opts: RunOpts): Promise<number> {
  const spawn = buildWrapperSpawn(opts);
  const here = await readCurrentPane();
  // Forward AGMUX_TMUX_SESSION through so the wrapper inside the new pane sees
  // the same logical agmux session name (only relevant if the wrapper ever
  // re-execs without an attached tmux, but cheap to keep consistent).
  const envForward: Record<string, string> = { ...spawn.env };
  const sessionOverride = process.env[AGMUX_TMUX_SESSION_ENV];
  if (sessionOverride) envForward[AGMUX_TMUX_SESSION_ENV] = sessionOverride;

  const cmd = [opts.wrapBin, ...spawn.argv];
  const windowName = `${spawn.label}-${shortRandomTag()}`;

  let coords: PaneCoords;
  if (opts.placement === "new-pane") {
    if (!here) {
      console.error(
        "agmux run --new-pane: not inside a tmux client; use --new-window or --new-session instead",
      );
      return 2;
    }
    coords = await splitPane({
      targetPane: here.pane,
      cmd, env: envForward,
      detach: opts.detach,
    });
  } else if (opts.placement === "new-window") {
    const targetSession = pickWindowTargetSession(here);
    coords = await newWindow({
      sessionName: targetSession,
      windowName, cmd, env: envForward,
      detach: opts.detach,
    });
  } else if (opts.placement === "new-session") {
    const sessionName = `${AGMUX_TMUX_SESSION_DEFAULT}-${spawn.label}-${shortRandomTag()}`;
    coords = await newSession({ sessionName, windowName, cmd, env: envForward });
    // `tmux new-session -d` ignores -d's "no switch" semantics — there's nothing
    // to switch *to* yet. So we explicitly switch-client when the user wants
    // focus to follow the new session.
    if (!opts.detach && here) {
      await switchClient(`${coords.session}:${coords.window}`);
    }
  } else {
    throw new Error(`runWithPlacement: unexpected placement ${opts.placement}`);
  }

  console.log(`agmux: spawned in ${coords.session}:${coords.window}.${coords.pane}`);
  return 0;
}

export async function runCmd(opts: RunOpts): Promise<number> {
  if (opts.placement === "inherit") return runInherit(opts);
  return runWithPlacement(opts);
}
