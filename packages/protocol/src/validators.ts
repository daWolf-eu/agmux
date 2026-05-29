import { EVENT_KINDS_MVP } from "./events.ts";

export type ValidationResult = { ok: true } | { ok: false; error: string };

function isStringNonEmpty(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}
function isInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v);
}
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

export function validateEnvelope(v: unknown): ValidationResult {
  if (!isPlainObject(v)) return { ok: false, error: "envelope: not an object" };
  for (const k of ["event_id", "ts", "session_id", "kind", "host"] as const) {
    if (!isStringNonEmpty(v[k])) return { ok: false, error: `envelope: ${k} missing or not non-empty string` };
  }
  if (!isInt(v.version)) return { ok: false, error: "envelope: version missing or not integer" };
  if (!("payload" in v)) return { ok: false, error: "envelope: payload missing" };
  return { ok: true };
}

export function validateKnownPayload(kind: string, payload: unknown): ValidationResult {
  if (!isPlainObject(payload)) return { ok: false, error: `${kind}: payload not an object` };
  switch (kind) {
    case "session.started": {
      const p = payload;
      if (p.agent_kind !== "claude" && p.agent_kind !== "codex")
        return { ok: false, error: "session.started: agent_kind invalid" };
      if (!isStringNonEmpty(p.command)) return { ok: false, error: "session.started: command missing" };
      if (!isStringArray(p.args)) return { ok: false, error: "session.started: args not string[]" };
      if (!isPlainObject(p.env_overrides)) return { ok: false, error: "session.started: env_overrides not object" };
      if (!isStringNonEmpty(p.cwd)) return { ok: false, error: "session.started: cwd missing" };
      if (!isInt(p.pid)) return { ok: false, error: "session.started: pid not integer" };
      return { ok: true };
    }
    case "session.heartbeat": {
      const p = payload;
      if (typeof p.pid_alive !== "boolean") return { ok: false, error: "session.heartbeat: pid_alive not boolean" };
      const w = p.winsize;
      if (!isPlainObject(w) || !isInt(w.rows) || !isInt(w.cols))
        return { ok: false, error: "session.heartbeat: winsize invalid" };
      return { ok: true };
    }
    case "session.resumed": {
      const p = payload;
      if (!isInt(p.new_pid)) return { ok: false, error: "session.resumed: new_pid not integer" };
      if (p.reason !== "cli_attach_after_death")
        return { ok: false, error: "session.resumed: reason invalid" };
      return { ok: true };
    }
    case "session.ended": {
      const p = payload;
      if (p.exit_code !== null && !isInt(p.exit_code))
        return { ok: false, error: "session.ended: exit_code not int|null" };
      if (p.signal !== null && !isStringNonEmpty(p.signal))
        return { ok: false, error: "session.ended: signal not string|null" };
      if (!(["normal", "signal", "pane_closed"] as const).includes(p.reason as never))
        return { ok: false, error: "session.ended: reason invalid" };
      return { ok: true };
    }
    case "session.linked": {
      if (!isStringNonEmpty(payload.native_session_id))
        return { ok: false, error: "session.linked: native_session_id missing" };
      return { ok: true };
    }
    case "turn.started":
    case "turn.ended":
    case "input.received":
    case "prompt.sent":
      // Log/state events with no load-bearing required fields. Payload-is-object
      // already checked above; anything else is optional/best-effort.
      return { ok: true };
    case "input.required": {
      if (payload.kind !== "prompt" && payload.kind !== "permission" && payload.kind !== "confirm")
        return { ok: false, error: "input.required: kind must be prompt|permission|confirm" };
      return { ok: true };
    }
    case "usage.reported": {
      if (typeof payload.cumulative !== "boolean")
        return { ok: false, error: "usage.reported: cumulative not boolean" };
      if (!isStringNonEmpty(payload.source))
        return { ok: false, error: "usage.reported: source missing" };
      return { ok: true };
    }
    case "tool.used": {
      if (!isStringNonEmpty(payload.tool))
        return { ok: false, error: "tool.used: tool missing" };
      return { ok: true };
    }
    case "session.adapter_attached": {
      if (payload.agent_kind !== "claude" && payload.agent_kind !== "codex")
        return { ok: false, error: "session.adapter_attached: agent_kind invalid" };
      if (!isStringNonEmpty(payload.adapter_version))
        return { ok: false, error: "session.adapter_attached: adapter_version missing" };
      if (!isPlainObject(payload.capabilities))
        return { ok: false, error: "session.adapter_attached: capabilities not object" };
      return { ok: true };
    }
    default:
      // Unknown future kind: stored raw, validation passes.
      return { ok: true };
  }
}

export const MVP_KINDS = EVENT_KINDS_MVP;
