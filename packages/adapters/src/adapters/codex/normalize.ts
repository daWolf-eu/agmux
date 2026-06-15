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

// Filled in Task 4.
function normalizeUsage(_input: NormalizeInput, _raw: CodexHookStdin): NormalizeOutput {
  const _events: CanonicalEvent[] = [];
  return { events: _events };
}
