import type { NormalizeInput, NormalizeOutput } from "../../core/types.ts";

// The JSON the embedded extension writes to `agmux emit` stdin (extension-files.ts).
interface PiHookStdin {
  session_id?: string;
  cwd?: string;
  pid?: number;
  reason?: string;
  prompt?: string;
  tool_name?: string | null;
  is_error?: boolean;
  model?: string | null;
  message_id?: string | null;
  usage?: Record<string, unknown>;
}

export function normalizePi(input: NormalizeInput): NormalizeOutput {
  const raw = (input.raw ?? {}) as PiHookStdin & Record<string, unknown>;
  // No nesting guard (cf. codex): PI exports no native session-id env var to
  // cross-check, so nested runs self-register under their own UUID (spec §5).
  switch (input.point) {
    case "session.registered": {
      if (!raw.session_id) return { events: [] };
      const env = input.env ?? {};
      const fromPayload = typeof raw.pid === "number" ? raw.pid : NaN;
      const fromEnv = env.AGMUX_AGENT_PID != null ? Number(env.AGMUX_AGENT_PID) : NaN;
      const pidNum = Number.isInteger(fromPayload) ? fromPayload : fromEnv;
      return { events: [{
        kind: "session.registered",
        payload: {
          native_session_id: raw.session_id,
          agent_kind: "pi",
          pid: Number.isInteger(pidNum) ? pidNum : null,
          cwd: raw.cwd ?? env.PWD ?? null,
          tmux_session: null,
          tmux_window: null,
          tmux_pane: env.TMUX_PANE ?? null,
          profile: env.AGMUX_PROFILE ?? null,
          agent_version: env.PI_VERSION ?? null,
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
    case "prompt.sent":
      return { events: [{ kind: "prompt.sent", payload: { chars: typeof raw.prompt === "string" ? raw.prompt.length : null, redacted: true } }] };
    case "tool.used": {
      const tool = typeof raw.tool_name === "string" ? raw.tool_name : "unknown";
      // pi reports failure directly via is_error; mirror claude/codex `detail`.
      if (raw.is_error === true) return { events: [{ kind: "tool.used", payload: { tool, ok: false, detail: "error" } }] };
      return { events: [{ kind: "tool.used", payload: { tool, ok: true } }] };
    }
    case "usage.reported":
      return normalizeUsage(raw);
    default:
      return { events: [] };
  }
}

// Read the first numeric value among the candidate keys; null if none present.
// Tolerates PI's exact usage field names being snake_case OR camelCase (the
// precise shape is confirmed only at live verification — spec §8.1).
function num(o: Record<string, unknown> | undefined, ...keys: string[]): number | null {
  if (!o) return null;
  for (const k of keys) { const v = o[k]; if (typeof v === "number") return v; }
  return null;
}

function normalizeUsage(raw: PiHookStdin): NormalizeOutput {
  const u = raw.usage;
  if (!u) return { events: [] };
  const nativeId = raw.session_id ?? "unknown";
  const msgId = raw.message_id ?? "0";
  return { events: [{
    kind: "usage.reported",
    payload: {
      cumulative: false,
      source: "hook-command",
      model: raw.model ?? null,
      input_tokens: num(u, "input_tokens", "inputTokens", "prompt_tokens", "promptTokens"),
      output_tokens: num(u, "output_tokens", "outputTokens", "completion_tokens", "completionTokens"),
      cache_read_tokens: num(u, "cache_read_tokens", "cacheReadTokens", "cached_input_tokens", "cachedInputTokens"),
      cache_write_tokens: num(u, "cache_write_tokens", "cacheWriteTokens", "cache_creation_input_tokens", "cacheCreationInputTokens"),
      reasoning_output_tokens: num(u, "reasoning_output_tokens", "reasoningOutputTokens", "reasoning_tokens", "reasoningTokens"),
      total_tokens: num(u, "total_tokens", "totalTokens"),
      model_context_window: num(u, "model_context_window", "modelContextWindow", "context_window", "contextWindow"),
      rate_limit: null,
      turn_id: null,
      as_of: null,
    },
    dedup_key: `pi:hook-command:${nativeId}:${msgId}`,
  }] };
}
