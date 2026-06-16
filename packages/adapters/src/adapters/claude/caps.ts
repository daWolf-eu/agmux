import type { CapabilityMap } from "@agmux/protocol";
import type { CapabilitySource } from "../../core/types.ts";

// Two event-triggered sources (spec §3). hook-command drives the state machine +
// optional log-only points; transcript-delta carries usage (the only stateful read).
export const CLAUDE_SOURCES: CapabilitySource[] = [
  {
    type: "hook-command",
    activation: "event-triggered",
    points: ["session.registered", "session.linked", "turn.started", "turn.ended", "input.required", "tool.used", "prompt.sent"],
  },
  {
    type: "transcript-delta",
    activation: "event-triggered",
    points: ["usage.reported"],
  },
];

// Finest-grain descriptors (spec §4). input.required is "partial" — Claude's
// Notification hook is multi-purpose; the adapter discriminates by notification_type:
// permission_prompt → permission, elicitation_dialog → prompt; idle_prompt, auth_success,
// and other ack types are dropped (not blocks). input.received is omitted:
// it is fulfilled implicitly by the next turn.started, never emitted.
export const CLAUDE_CAPABILITIES: CapabilityMap = {
  "session.registered": { fulfil: "yes", source: "hook-command", liveness: "live" },
  "session.linked": { fulfil: "yes", source: "hook-command", liveness: "live" },
  "turn.started": { fulfil: "yes", source: "hook-command", liveness: "live" },
  "turn.ended": { fulfil: "yes", source: "hook-command", liveness: "live" },
  "input.required": { fulfil: "partial", source: "hook-command", liveness: "live" },
  "usage.reported": { fulfil: "yes", source: "transcript-delta", liveness: "backfilled" },
  "tool.used": { fulfil: "yes", source: "hook-command", liveness: "live" },
  "prompt.sent": { fulfil: "yes", source: "hook-command", liveness: "live" },
};
