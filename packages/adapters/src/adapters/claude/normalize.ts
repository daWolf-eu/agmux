import * as fs from "node:fs";
import type { NormalizeInput, NormalizeOutput, CanonicalEvent } from "../../core/types.ts";

interface ClaudeHookStdin {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  prompt?: string;
  tool_name?: string;
  notification_type?: string;
  reason?: string;
}

export function normalizeClaude(input: NormalizeInput): NormalizeOutput {
  const raw = (input.raw ?? {}) as ClaudeHookStdin & Record<string, unknown>;
  // Nesting guard (Stage 2): only meaningful when a wrapper CLAIM is in play.
  // With a claim, an env-vs-stdin mismatch means a nested `claude` inherited our
  // AGMUX_SESSION_ID — drop it rather than pollute the claimed session. Without a
  // claim (direct/native exec) every run self-registers under its own native id,
  // so the mismatch is a legitimate sub-agent and must pass through.
  const claim = input.env?.AGMUX_SESSION_ID;
  const envSid = input.env?.CLAUDE_CODE_SESSION_ID;
  if (claim && envSid && raw.session_id && envSid !== raw.session_id) return { events: [] };
  switch (input.point) {
    case "session.registered": {
      if (!raw.session_id) return { events: [] };
      const env = input.env ?? {};
      const pidNum = env.AGMUX_AGENT_PID != null ? Number(env.AGMUX_AGENT_PID) : NaN;
      return { events: [{
        kind: "session.registered",
        payload: {
          native_session_id: raw.session_id,
          agent_kind: "claude",
          pid: Number.isInteger(pidNum) ? pidNum : null,
          cwd: raw.cwd ?? env.PWD ?? null,
          tmux_session: null,           // Stage 2 (attach flip) enriches tmux coords
          tmux_window: null,
          tmux_pane: env.TMUX_PANE ?? null,
          profile: env.AGMUX_PROFILE ?? null,
          agent_version: env.CLAUDE_CODE_VERSION ?? null,
          parent: null,                 // lineage hint wired by the future spawn path (spec §5)
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
    case "input.required": {
      const kind = raw.notification_type === "permission_prompt" ? "permission" : "prompt";
      return { events: [{ kind: "input.required", payload: { kind } }] };
    }
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

// Read NEW assistant records from the transcript since the byte cursor. Each
// carries a per-turn usage delta; rec.uuid makes the dedup key stable so a
// re-read (duplicate Stop, resume re-scan) never double-counts (spec §5).
function normalizeUsage(input: NormalizeInput, raw: ClaudeHookStdin): NormalizeOutput {
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
  const events: CanonicalEvent[] = [];
  for (const line of consumable.split("\n")) {
    if (line.trim() === "") continue;
    let rec: any;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec?.type !== "assistant") continue;
    const u = rec.message?.usage;
    if (!u) continue;
    events.push({
      kind: "usage.reported",
      payload: {
        cumulative: false,
        source: "transcript-delta",
        model: rec.message?.model ?? null,
        input_tokens: u.input_tokens ?? null,
        output_tokens: u.output_tokens ?? null,
        cache_read_tokens: u.cache_read_input_tokens ?? null,
        cache_write_tokens: u.cache_creation_input_tokens ?? null,
        turn_id: rec.message?.id ?? null,
        as_of: rec.timestamp ?? null,
      },
      dedup_key: `claude:transcript-delta:${nativeId}:${rec.uuid}`,
    });
  }
  return { events, cursor: String(newCursor) };
}
