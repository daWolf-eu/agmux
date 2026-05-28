import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  AGMUX_SESSION_ID_ENV,
  AGMUX_HUB_URL_ENV,
  AGMUX_TMUX_SESSION_ENV,
  AGMUX_TMUX_SESSION_DEFAULT,
} from "@agmux/protocol";
import { openPty, setWinsize } from "./pty.ts";
import { loadProfile } from "./profile.ts";
import { HubClient } from "./hub-client.ts";
import { mintSessionId } from "./ids.ts";
import { buildStartedEvent, buildEndedEvent, buildResumedEvent } from "./lifecycle.ts";
import { startHeartbeat } from "./heartbeat.ts";
import {
  ensureAgmuxSession, readCurrentTmuxCoords, newAgmuxWindow, tmuxVersion,
} from "./tmux.ts";

export interface RunOpts {
  profileName: string;
  configPath: string;
  stateDir: string;
  hubUrl: string;
  argv: string[]; // process.argv.slice(2)
}

export async function runWrapper(opts: RunOpts): Promise<number> {
  const profile = loadProfile(opts.profileName, opts.configPath);

  // Identity: reuse parent-set AGMUX_SESSION_ID (resume) or mint fresh (new).
  const parentId = process.env[AGMUX_SESSION_ID_ENV];
  const sessionId = parentId && parentId.length > 0 ? parentId : mintSessionId();
  const isResume = !!parentId;

  const host = os.hostname();
  const queueDir = path.join(opts.stateDir, "queue");
  const client = new HubClient({ hubUrl: opts.hubUrl, queueDir, sessionId });

  // Tmux session name is overridable so e2e tests don't collide with the user's real "agmux".
  const tmuxSessionName = process.env[AGMUX_TMUX_SESSION_ENV] ?? AGMUX_TMUX_SESSION_DEFAULT;

  // Tmux placement.
  let tmuxCoords = await readCurrentTmuxCoords();
  if (!tmuxCoords) {
    const v = await tmuxVersion();
    if (!v) {
      console.error("agmux-wrap: tmux not found on PATH");
      return 2;
    }
    const major = Number(v.split(".")[0]);
    if (major < 3) {
      console.error(`agmux-wrap: tmux >=3.2 required, found ${v}`);
      return 2;
    }
    await ensureAgmuxSession(tmuxSessionName);
    const shortId = sessionId.slice(0, 8);
    const windowName = `${opts.profileName}-${shortId}`;
    // The new window itself runs the same wrapper, but with $TMUX set inside the pane
    // so the next call detects the existing pane and proceeds inline.
    // We pass our own argv along to that inner invocation.
    const innerCmd = ["bun", import.meta.path.replace(/\/src\/index\.ts$/, "/bin/agmux-wrap.ts"),
      ...opts.argv];
    tmuxCoords = await newAgmuxWindow(tmuxSessionName, windowName, innerCmd);
    // Hand the user off to that window; on detach the outer wrapper exits 0.
    const { $ } = await import("bun");
    // Use 'tmux attach; tmux select-window' as separate commands — Bun's $ does not
    // shell-expand \; so we cannot use it as a command separator inline.
    await $`tmux attach-session -t ${tmuxSessionName}`.nothrow();
    return 0;
  }

  // We are inside a tmux pane — run the agent here.
  const initRows = process.stdout.rows || 24;
  const initCols = process.stdout.columns || 80;
  const { master, slave, slaveOut, slaveErr } = openPty(initRows, initCols);

  const child = Bun.spawn([profile.command, ...profile.args], {
    stdin: slave, stdout: slaveOut, stderr: slaveErr,
    cwd: profile.cwd ?? process.cwd(),
    env: {
      ...process.env,
      ...profile.env,
      [AGMUX_SESSION_ID_ENV]: sessionId,
      [AGMUX_HUB_URL_ENV]: opts.hubUrl,
    },
  });
  for (const fd of [slave, slaveOut, slaveErr]) { try { fs.closeSync(fd); } catch {} }

  const cwd = profile.cwd ?? process.cwd();
  if (isResume) {
    await client.post(buildResumedEvent({
      sessionId, host, newPid: child.pid!,
      tmux: { session: tmuxCoords.session, window: tmuxCoords.window, pane: tmuxCoords.pane },
    }));
  } else {
    await client.post(buildStartedEvent({
      sessionId, host,
      agent_kind: profile.agent_kind, profile: opts.profileName,
      command: profile.command, args: profile.args, env_overrides: profile.env,
      cwd, pid: child.pid!,
      tmux: tmuxCoords, project: null,
    }));
  }

  // Heartbeat
  const stopHeartbeat = startHeartbeat({
    client, sessionId, host, pid: child.pid!,
    getWinsize: () => ({ rows: process.stdout.rows || 24, cols: process.stdout.columns || 80 }),
  });

  // Stdio pumps
  const stdinIsTty = process.stdin.isTTY;
  if (stdinIsTty) process.stdin.setRawMode(true);
  const restore = () => { if (stdinIsTty) { try { process.stdin.setRawMode(false); } catch {} } };

  const mr = fs.createReadStream("", { fd: master, autoClose: false });
  mr.on("data", (chunk) => process.stdout.write(chunk));
  mr.on("error", () => {});
  process.stdin.on("data", (chunk: Buffer) => { try { fs.writeSync(master, chunk); } catch {} });
  if (stdinIsTty) process.stdin.resume();

  process.stdout.on("resize", () => {
    setWinsize(master, process.stdout.rows || 24, process.stdout.columns || 80);
  });

  // Signals: SIGHUP carries the "pane closed" semantic; others are regular signal-death.
  let endReasonOverride: "pane_closed" | undefined;
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"] as const) {
    process.on(sig, () => {
      if (sig === "SIGHUP") endReasonOverride = "pane_closed";
      try { child.kill(sig); } catch {}
    });
  }

  await child.exited;
  stopHeartbeat();
  restore();
  try { fs.closeSync(master); } catch {}

  const signal = child.signalCode ?? null;
  const exitCode = child.exitCode ?? null;
  await client.post(buildEndedEvent({
    sessionId, host, exitCode, signal,
    reasonOverride: endReasonOverride,
  }));
  await client.flushQueue();

  if (signal) {
    process.removeAllListeners(signal);
    process.kill(process.pid, signal as NodeJS.Signals);
    return 128 + 0; // unreachable
  }
  return exitCode ?? 0;
}
