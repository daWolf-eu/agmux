import type { AgentKind } from "./session.ts";
import type { UsageReport, CapabilityMap } from "./telemetry.ts";

export const EVENT_KINDS_MVP = [
  "session.started",
  "session.heartbeat",
  "session.resumed",
  "session.ended",
] as const;
export type MvpEventKind = (typeof EVENT_KINDS_MVP)[number];

export const EVENT_KINDS_ADAPTER = [
  "session.linked",
  "turn.started",
  "turn.ended",
  "input.required",
  "input.received",
  "usage.reported",
  "tool.used",
  "prompt.sent",
  "session.adapter_attached",
] as const;
export type AdapterEventKind = (typeof EVENT_KINDS_ADAPTER)[number];

export interface EventEnvelope<P = unknown> {
  event_id: string;     // ULID
  ts: string;           // ISO-8601 UTC, ms precision
  session_id: string;   // UUIDv7
  kind: string;         // not narrowed — unknown kinds permitted
  version: number;      // per-kind schema version (default 1)
  host: string;         // hostname
  payload: P;
  dedup_key?: string | null; // optional source-idempotency key (§4.4)
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

export interface SessionLinkedPayload {
  native_session_id: string;
}

export interface TurnStartedPayload {
  turn_id?: string | null;
  prompt_chars?: number | null;
}

export interface TurnEndedPayload {
  turn_id?: string | null;
  reason?: string | null;
}

export interface InputRequiredPayload {
  kind: "prompt" | "permission" | "confirm";
  detail?: string | null;
}

export type InputReceivedPayload = Record<string, never>;

export interface ToolUsedPayload {
  tool: string;
  ok?: boolean | null;
  detail?: string | null;
}

export interface PromptSentPayload {
  chars?: number | null;
  redacted: true;
}

export type UsageReportedPayload = UsageReport;

export interface AdapterAttachedPayload {
  agent_kind: AgentKind;
  profile: string | null;
  adapter_version: string;
  capabilities: CapabilityMap;
}

export type SessionStartedEvent = EventEnvelope<SessionStartedPayload> & { kind: "session.started" };
export type SessionHeartbeatEvent = EventEnvelope<SessionHeartbeatPayload> & { kind: "session.heartbeat" };
export type SessionResumedEvent = EventEnvelope<SessionResumedPayload> & { kind: "session.resumed" };
export type SessionEndedEvent = EventEnvelope<SessionEndedPayload> & { kind: "session.ended" };

export type SessionLinkedEvent = EventEnvelope<SessionLinkedPayload> & { kind: "session.linked" };
export type TurnStartedEvent = EventEnvelope<TurnStartedPayload> & { kind: "turn.started" };
export type TurnEndedEvent = EventEnvelope<TurnEndedPayload> & { kind: "turn.ended" };
export type InputRequiredEvent = EventEnvelope<InputRequiredPayload> & { kind: "input.required" };
export type InputReceivedEvent = EventEnvelope<InputReceivedPayload> & { kind: "input.received" };
export type UsageReportedEvent = EventEnvelope<UsageReportedPayload> & { kind: "usage.reported" };
export type ToolUsedEvent = EventEnvelope<ToolUsedPayload> & { kind: "tool.used" };
export type PromptSentEvent = EventEnvelope<PromptSentPayload> & { kind: "prompt.sent" };
export type AdapterAttachedEvent = EventEnvelope<AdapterAttachedPayload> & { kind: "session.adapter_attached" };

export type KnownEvent =
  | SessionStartedEvent
  | SessionHeartbeatEvent
  | SessionResumedEvent
  | SessionEndedEvent
  | SessionLinkedEvent
  | TurnStartedEvent
  | TurnEndedEvent
  | InputRequiredEvent
  | InputReceivedEvent
  | UsageReportedEvent
  | ToolUsedEvent
  | PromptSentEvent
  | AdapterAttachedEvent;
