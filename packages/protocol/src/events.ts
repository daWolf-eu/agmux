import type { AgentKind } from "./session.ts";
import type { UsageReport, CapabilityMap } from "./telemetry.ts";
import type { TitleActivity } from "./title.ts";

export const EVENT_KINDS_MVP = [
  "session.started",
  "session.heartbeat",
  "session.resumed",
  "session.ended",
] as const;
export type MvpEventKind = (typeof EVENT_KINDS_MVP)[number];

export const EVENT_KINDS_ADAPTER = [
  "session.registered",
  "session.linked",
  "turn.started",
  "turn.ended",
  "input.required",
  "input.received",
  "usage.reported",
  "tool.started",
  "tool.used",
  "title.changed",
  "prompt.sent",
  "compaction",
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

// Native identity: how a hook-emitted event names its session when no canonical
// id exists yet. The hub resolves (agent_kind, native_session_id, host) → a
// canonical session at ingest (spec §2).
export interface NativeIdentity {
  agent_kind: AgentKind;
  native_session_id: string;
}

// The wire form accepted by POST /ingest. EXACTLY ONE of `session_id` (canonical)
// or `identity` (native) must be present (validateIngestEnvelope enforces it).
// `claim_session_id` is the wrapper bridge hint (from AGMUX_SESSION_ID), set only
// by the wrapper/launcher. The hub rewrites this into a storage EventEnvelope.
export interface IngestEnvelope<P = unknown> {
  event_id: string;
  ts: string;
  kind: string;
  version: number;
  host: string;
  payload: P;
  dedup_key?: string | null;
  session_id?: string | null;
  identity?: NativeIdentity | null;
  claim_session_id?: string | null;
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
  tmux_socket: string | null;
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
  new_tmux_socket: string | null;
  reason: "cli_attach_after_death";
}

export interface SessionEndedPayload {
  exit_code: number | null;
  signal: string | null;
  reason: "normal" | "signal" | "pane_closed";
}

// Marks a session acknowledged by the user. "unseen" is expressed as a later
// attention event, not as a delete — the log is append-only (foundation §14.3).
// Explicit acknowledgements only. Interacting with the agent (turn.started,
// input.received) also counts as seen, but the projection derives that from the
// event itself, so no session.seen is emitted for it.
export const SEEN_SOURCES = ["attach", "dismiss", "focus"] as const;
export type SeenSource = (typeof SEEN_SOURCES)[number];

export interface SessionSeenPayload {
  // focus = a tmux client focused the agent's pane (pane-focus-in hook), or the
  // turn ended while a focused client was already showing it (notifyd).
  source: SeenSource;
}

export interface SessionLinkedPayload {
  native_session_id: string;
}

// The native lifecycle root (spec §2.2). Carries the session's own native id plus
// the row-synthesis fields used when the hub mints. `parent` is a lineage hint in
// the parent's native identity (spec §5), resolved to parent_session_id at ingest.
export interface SessionRegisteredPayload {
  native_session_id: string;
  agent_kind: AgentKind;
  pid: number | null;
  cwd: string | null;
  tmux_session: string | null;
  tmux_window: string | null;
  tmux_pane: string | null;
  tmux_socket: string | null;
  profile: string | null;
  agent_version: string | null;
  parent: NativeIdentity | null;
  // Config-affecting env captured from the agent's hook env at registration —
  // ONLY the adapter's declared relaunchEnvKeys (allowlist). Restored at relaunch
  // so a native session resumes under the same config dir. Optional/absent on
  // older emitters → treated as {}.
  env_overrides?: Record<string, string>;
}

// Hub-emitted (pid-sweep) observation that a native session's pid is gone (spec §3).
export interface SessionLostPayload {
  reason: "pid_dead";
}

export interface TurnStartedPayload {
  turn_id?: string | null;
  prompt_chars?: number | null;
}

export interface TurnEndedPayload {
  turn_id?: string | null;
  reason?: string | null;
}

export const INPUT_KINDS = ["prompt", "permission", "confirm", "question"] as const;
export type InputKind = (typeof INPUT_KINDS)[number];

export interface InputRequiredPayload {
  // question = the agent asked the user a structured question (Claude's
  // AskUserQuestion), as opposed to asking permission to run a tool.
  kind: InputKind;
  detail?: string | null;
}

export type InputReceivedPayload = Record<string, never>;

export interface ToolUsedPayload {
  tool: string;
  ok?: boolean | null;
  detail?: string | null;
}

// A tool is ABOUT to run (Claude/Codex PreToolUse, pi tool_execution_start).
// Proof the agent is working again — in particular that a permission prompt was
// answered — so the projection moves the session to running and records the
// tool as current before it runs.
export interface ToolStartedPayload {
  tool: string;
  detail?: string | null;
}

// The agent's terminal title changed (OSC 0/2 seen by the PTY wrapper, or
// #{pane_title} polled by notifyd for native sessions). `activity` is the
// emitter's classification (parseAgentTitle); `title` has the glyph stripped.
// Also re-sent periodically while working (TITLE_KEEPALIVE_MS).
export interface TitleChangedPayload {
  title: string;
  activity: TitleActivity | null;
}

export interface PromptSentPayload {
  chars?: number | null;
  redacted: true;
}

// A context compaction happened mid-session (Claude PreCompact). Log-only: the
// fact is queryable from the event log; identity rotation is handled separately by
// SessionStart re-registration (resolve.ts rule 3). `trigger` is the provider's
// cause when known ("manual" = user /compact, "auto" = auto-compaction).
export interface CompactionPayload {
  trigger?: "manual" | "auto" | null;
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
export type SessionSeenEvent = EventEnvelope<SessionSeenPayload> & { kind: "session.seen" };

export type SessionLinkedEvent = EventEnvelope<SessionLinkedPayload> & { kind: "session.linked" };
export type SessionRegisteredEvent = EventEnvelope<SessionRegisteredPayload> & { kind: "session.registered" };
export type SessionLostEvent = EventEnvelope<SessionLostPayload> & { kind: "session.lost" };
export type TurnStartedEvent = EventEnvelope<TurnStartedPayload> & { kind: "turn.started" };
export type TurnEndedEvent = EventEnvelope<TurnEndedPayload> & { kind: "turn.ended" };
export type InputRequiredEvent = EventEnvelope<InputRequiredPayload> & { kind: "input.required" };
export type InputReceivedEvent = EventEnvelope<InputReceivedPayload> & { kind: "input.received" };
export type UsageReportedEvent = EventEnvelope<UsageReportedPayload> & { kind: "usage.reported" };
export type ToolUsedEvent = EventEnvelope<ToolUsedPayload> & { kind: "tool.used" };
export type ToolStartedEvent = EventEnvelope<ToolStartedPayload> & { kind: "tool.started" };
export type TitleChangedEvent = EventEnvelope<TitleChangedPayload> & { kind: "title.changed" };
export type PromptSentEvent = EventEnvelope<PromptSentPayload> & { kind: "prompt.sent" };
export type CompactionEvent = EventEnvelope<CompactionPayload> & { kind: "compaction" };
export type AdapterAttachedEvent = EventEnvelope<AdapterAttachedPayload> & { kind: "session.adapter_attached" };

export type KnownEvent =
  | SessionStartedEvent
  | SessionHeartbeatEvent
  | SessionResumedEvent
  | SessionEndedEvent
  | SessionSeenEvent
  | SessionLinkedEvent
  | SessionRegisteredEvent
  | SessionLostEvent
  | TurnStartedEvent
  | TurnEndedEvent
  | InputRequiredEvent
  | InputReceivedEvent
  | UsageReportedEvent
  | ToolUsedEvent
  | ToolStartedEvent
  | TitleChangedEvent
  | PromptSentEvent
  | CompactionEvent
  | AdapterAttachedEvent;
