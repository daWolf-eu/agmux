import type { CapabilityMap } from "@agmux/protocol";
import type { CapabilitySource } from "../../core/types.ts";

// Two event-triggered sources (spec §3). hook-command drives the state machine +
// optional log-only points; transcript-delta carries usage (the only stateful read).
export const CLAUDE_SOURCES: CapabilitySource[] = [
  {
    type: "hook-command",
    activation: "event-triggered",
    points: ["session.registered", "session.linked", "turn.started", "turn.ended", "input.required", "input.received", "tool.started", "tool.used", "prompt.sent", "compaction"],
  },
  {
    type: "transcript-delta",
    activation: "event-triggered",
    points: ["usage.reported"],
  },
];

// Restored verbatim at relaunch so `claude --resume <id>` finds the conversation
// under the right config dir. Allowlist only (spec §6.4 / secrets guard).
export const CLAUDE_RELAUNCH_ENV_KEYS = ["CLAUDE_CONFIG_DIR"] as const;

// Finest-grain descriptors (spec §4). input.required is "partial" — Claude's
// Notification hook is multi-purpose; the adapter discriminates by notification_type:
// permission_prompt → permission, elicitation_dialog → prompt; idle_prompt, auth_success,
// and other ack types are dropped (not blocks); a PreToolUse of AskUserQuestion
// → question. input.received is "partial": emitted only when an AskUserQuestion
// is answered — an answered permission is reported by the next tool.started.
export const CLAUDE_CAPABILITIES: CapabilityMap = {
  "session.registered": { fulfil: "yes", source: "hook-command", liveness: "live" },
  "session.linked": { fulfil: "yes", source: "hook-command", liveness: "live" },
  "turn.started": { fulfil: "yes", source: "hook-command", liveness: "live" },
  "turn.ended": { fulfil: "yes", source: "hook-command", liveness: "live" },
  "input.required": { fulfil: "partial", source: "hook-command", liveness: "live" },
  "input.received": { fulfil: "partial", source: "hook-command", liveness: "live" },
  "tool.started": { fulfil: "yes", source: "hook-command", liveness: "live" },
  "usage.reported": { fulfil: "yes", source: "transcript-delta", liveness: "backfilled" },
  "tool.used": { fulfil: "yes", source: "hook-command", liveness: "live" },
  "prompt.sent": { fulfil: "yes", source: "hook-command", liveness: "live" },
  "compaction": { fulfil: "yes", source: "hook-command", liveness: "live" },
};
