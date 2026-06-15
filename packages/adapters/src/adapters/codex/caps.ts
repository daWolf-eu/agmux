import type { CapabilityMap } from "@agmux/protocol";
import type { CapabilitySource } from "../../core/types.ts";

// Two event-triggered sources (spec §3), identical shape to Claude. hook-command
// drives the state machine + log-only points; transcript-delta carries usage (the
// only stateful read — Codex has no usage hook).
export const CODEX_SOURCES: CapabilitySource[] = [
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

// Finest-grain descriptors (spec §4). input.required is "partial" — Codex's
// PermissionRequest hook is permission-only (no idle/prompt-waiting hook), the
// mirror image of Claude's coarse Notification. input.received is omitted: it is
// fulfilled implicitly by the next turn.started, never emitted.
export const CODEX_CAPABILITIES: CapabilityMap = {
  "session.registered": { fulfil: "yes", source: "hook-command", liveness: "live" },
  "session.linked": { fulfil: "yes", source: "hook-command", liveness: "live" },
  "turn.started": { fulfil: "yes", source: "hook-command", liveness: "live" },
  "turn.ended": { fulfil: "yes", source: "hook-command", liveness: "live" },
  "input.required": { fulfil: "partial", source: "hook-command", liveness: "live" },
  "usage.reported": { fulfil: "yes", source: "transcript-delta", liveness: "backfilled" },
  "tool.used": { fulfil: "yes", source: "hook-command", liveness: "live" },
  "prompt.sent": { fulfil: "yes", source: "hook-command", liveness: "live" },
};
