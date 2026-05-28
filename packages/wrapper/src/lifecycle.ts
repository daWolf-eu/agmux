import { mintEventId } from "./ids.ts";
import type {
  SessionStartedEvent, SessionHeartbeatEvent,
  SessionEndedEvent, SessionResumedEvent,
  AgentKind,
} from "@agmux/protocol";

function nowIso(): string { return new Date().toISOString(); }

export interface BuildStartedArgs {
  sessionId: string;
  host: string;
  agent_kind: AgentKind;
  profile: string | null;
  command: string;
  args: string[];
  env_overrides: Record<string, string>;
  cwd: string;
  pid: number;
  tmux: { session: string | null; window: string | null; pane: string | null };
  project: string | null;
}

export function buildStartedEvent(a: BuildStartedArgs): SessionStartedEvent {
  return {
    event_id: mintEventId(),
    ts: nowIso(),
    session_id: a.sessionId,
    kind: "session.started",
    version: 1,
    host: a.host,
    payload: {
      agent_kind: a.agent_kind,
      profile: a.profile,
      command: a.command,
      args: a.args,
      env_overrides: a.env_overrides,
      cwd: a.cwd,
      pid: a.pid,
      tmux_session: a.tmux.session,
      tmux_window: a.tmux.window,
      tmux_pane: a.tmux.pane,
      project: a.project,
    },
  };
}

export function buildHeartbeatEvent(a: {
  sessionId: string; host: string; pid: number; rows: number; cols: number;
}): SessionHeartbeatEvent {
  return {
    event_id: mintEventId(),
    ts: nowIso(),
    session_id: a.sessionId,
    kind: "session.heartbeat",
    version: 1,
    host: a.host,
    payload: { pid_alive: true, winsize: { rows: a.rows, cols: a.cols } },
  };
}

export function buildEndedEvent(a: {
  sessionId: string; host: string; exitCode: number | null; signal: string | null;
  reasonOverride?: "normal" | "signal" | "pane_closed";
}): SessionEndedEvent {
  const reason: "normal" | "signal" | "pane_closed" = a.reasonOverride
    ?? (a.signal ? "signal" : "normal");
  return {
    event_id: mintEventId(),
    ts: nowIso(),
    session_id: a.sessionId,
    kind: "session.ended",
    version: 1,
    host: a.host,
    payload: { exit_code: a.exitCode, signal: a.signal, reason },
  };
}

export function buildResumedEvent(a: {
  sessionId: string; host: string; newPid: number;
  tmux: { session: string | null; window: string | null; pane: string | null };
}): SessionResumedEvent {
  return {
    event_id: mintEventId(),
    ts: nowIso(),
    session_id: a.sessionId,
    kind: "session.resumed",
    version: 1,
    host: a.host,
    payload: {
      new_pid: a.newPid,
      new_tmux_session: a.tmux.session,
      new_tmux_window: a.tmux.window,
      new_tmux_pane: a.tmux.pane,
      reason: "cli_attach_after_death",
    },
  };
}
