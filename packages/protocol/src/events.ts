import type { AgentKind } from "./session.ts";

export const EVENT_KINDS_MVP = [
  "session.started",
  "session.heartbeat",
  "session.resumed",
  "session.ended",
] as const;
export type MvpEventKind = (typeof EVENT_KINDS_MVP)[number];

export interface EventEnvelope<P = unknown> {
  event_id: string;     // ULID
  ts: string;           // ISO-8601 UTC, ms precision
  session_id: string;   // UUIDv7
  kind: string;         // not narrowed — unknown kinds permitted
  version: number;      // per-kind schema version (default 1)
  host: string;         // hostname
  payload: P;
}

export interface SessionStartedPayload {
  agent_kind: AgentKind;
  profile: string | null;
  command: string;
  args: string[];
  env_overrides: Record<string, string>;
  cwd: string;
  pid: number;
  tmux_session: string | null;
  tmux_window: string | null;
  tmux_pane: string | null;
  project: string | null;
}

export interface SessionHeartbeatPayload {
  pid_alive: boolean;
  winsize: { rows: number; cols: number };
}

export interface SessionResumedPayload {
  new_pid: number;
  new_tmux_session: string | null;
  new_tmux_window: string | null;
  new_tmux_pane: string | null;
  reason: "cli_attach_after_death";
}

export interface SessionEndedPayload {
  exit_code: number | null;
  signal: string | null;
  reason: "normal" | "signal" | "pane_closed";
}

export type SessionStartedEvent = EventEnvelope<SessionStartedPayload> & { kind: "session.started" };
export type SessionHeartbeatEvent = EventEnvelope<SessionHeartbeatPayload> & { kind: "session.heartbeat" };
export type SessionResumedEvent = EventEnvelope<SessionResumedPayload> & { kind: "session.resumed" };
export type SessionEndedEvent = EventEnvelope<SessionEndedPayload> & { kind: "session.ended" };

export type KnownEvent =
  | SessionStartedEvent
  | SessionHeartbeatEvent
  | SessionResumedEvent
  | SessionEndedEvent;
