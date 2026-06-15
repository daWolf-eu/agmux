import * as fs from "node:fs";
import type { NormalizeInput, NormalizeOutput, CanonicalEvent } from "../../core/types.ts";

interface CodexHookStdin {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  prompt?: string;
  tool_name?: string;
  turn_id?: string;
  model?: string;
  reason?: string;
}

export function normalizeCodex(input: NormalizeInput): NormalizeOutput {
  const raw = (input.raw ?? {}) as CodexHookStdin & Record<string, unknown>;
  // No nesting guard (cf. Claude): Codex exposes no native session-id env var to
  // cross-check against stdin session_id, so nested runs self-register under their
  // own id — the same as Claude's direct/native-exec path (spec §5.3).
  switch (input.point) {
    case "session.registered": {
      if (!raw.session_id) return { events: [] };
      const env = input.env ?? {};
      const pidNum = env.AGMUX_AGENT_PID != null ? Number(env.AGMUX_AGENT_PID) : NaN;
      return { events: [{
        kind: "session.registered",
        payload: {
          native_session_id: raw.session_id,
          agent_kind: "codex",
          pid: Number.isInteger(pidNum) ? pidNum : null,
          cwd: raw.cwd ?? env.PWD ?? null,
          tmux_session: null,
          tmux_window: null,
          tmux_pane: env.TMUX_PANE ?? null,
          profile: env.AGMUX_PROFILE ?? null,
          agent_version: env.CODEX_VERSION ?? null,
          parent: null,
        },
      }] };
    }
    case "session.linked":
      if (!raw.session_id) return { events: [] };
      return { events: [{ kind: "session.linked", payload: { native_session_id: raw.session_id } }] };
    case "turn.started":
      return { events: [{ kind: "turn.started", payload: {} }] };
    case "turn.ended":
      return { events: [{ kind: "turn.ended", payload: { reason: raw.reason ?? null } }] };
    case "input.required":
      // Codex's PermissionRequest hook is always an approval request — no idle/prompt
      // variant exists, so kind is always "permission" (spec §5.1).
      return { events: [{ kind: "input.required", payload: { kind: "permission" } }] };
    case "prompt.sent":
      return { events: [{ kind: "prompt.sent", payload: { chars: typeof raw.prompt === "string" ? raw.prompt.length : null, redacted: true } }] };
    case "tool.used":
      return { events: [{ kind: "tool.used", payload: { tool: typeof raw.tool_name === "string" ? raw.tool_name : "unknown", ok: true } }] };
    case "usage.reported":
      return normalizeUsage(input, raw);
    default:
      return { events: [] };
  }
}

// Read NEW rollout records since the byte cursor. Codex writes token_count as an
// `event_msg` whose payload.type === "token_count"; info.last_token_usage is the
// per-turn delta (info.total_token_usage is the session total — we want the delta
// so session_usage accumulates). Codex records have no stable per-record uuid, so
// the dedup key uses the record's byte offset (monotonic, stable across re-reads).
function normalizeUsage(input: NormalizeInput, raw: CodexHookStdin): NormalizeOutput {
  const transcriptPath = raw.transcript_path;
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return { events: [] };

  const start = input.cursor ? Number(input.cursor) : 0;
  const size = fs.statSync(transcriptPath).size;
  if (!Number.isFinite(start) || start < 0 || start >= size) return { events: [], cursor: String(size) };

  const buf = fs.readFileSync(transcriptPath);
  const slice = buf.subarray(start).toString("utf8");
  // Only consume whole lines; leave a trailing partial line for the next read.
  const lastNl = slice.lastIndexOf("\n");
  const consumable = lastNl < 0 ? "" : slice.slice(0, lastNl + 1);
  const newCursor = start + Buffer.byteLength(consumable, "utf8");

  const nativeId = raw.session_id ?? "unknown";
  const model = raw.model ?? null;
  const events: CanonicalEvent[] = [];
  let offset = start;
  for (const line of consumable.split("\n")) {
    const recOffset = offset;
    offset += Buffer.byteLength(line, "utf8") + 1; // +1 for the consumed "\n"
    if (line.trim() === "") continue;
    let rec: any;
    try { rec = JSON.parse(line); } catch { continue; }
    let tc: any = null;
    if (rec?.type === "event_msg" && rec.payload?.type === "token_count") tc = rec.payload;
    else if (rec?.type === "token_count") tc = rec; // defensive: future flattened shape
    if (!tc) continue;
    const u = tc.info?.last_token_usage;
    if (!u) continue;
    events.push({
      kind: "usage.reported",
      payload: {
        cumulative: false,
        source: "transcript-delta",
        model,
        input_tokens: u.input_tokens ?? null,
        output_tokens: u.output_tokens ?? null,
        cache_read_tokens: u.cached_input_tokens ?? null,
        cache_write_tokens: null, // Codex exposes no write-cache figure
        reasoning_output_tokens: u.reasoning_output_tokens ?? null,
        total_tokens: u.total_tokens ?? null,
        model_context_window: tc.info?.model_context_window ?? null,
        rate_limit: tc.rate_limits?.primary ?? null,
        turn_id: raw.turn_id ?? null,
        as_of: rec.timestamp ?? null,
      },
      dedup_key: `codex:transcript-delta:${nativeId}:${recOffset}`,
    });
  }
  return { events, cursor: String(newCursor) };
}
