import type { CapabilityMap } from "@agmux/protocol";
import type { CapabilitySource } from "../../core/types.ts";

// One event-triggered source. PI's extension IS the command runner (each handler
// spawns `agmux emit`), so the existing "hook-command" source type fits with no
// protocol change. Unlike claude/codex, usage arrives LIVE in the message_end
// event payload — no transcript-delta read, no cursor file.
export const PI_SOURCES: CapabilitySource[] = [
  {
    type: "hook-command",
    activation: "event-triggered",
    points: ["session.registered", "session.linked", "turn.started", "turn.ended", "tool.used", "prompt.sent", "usage.reported"],
  },
];

// Finest-grain descriptors (spec §4). input.required is OMITTED: PI exposes no
// native permission/idle signal, so the "waiting" status is never surfaced
// (honest partial coverage). input.received is omitted too — fulfilled implicitly
// by the next turn.started (cf. claude/codex).
export const PI_CAPABILITIES: CapabilityMap = {
  "session.registered": { fulfil: "yes", source: "hook-command", liveness: "live" },
  "session.linked": { fulfil: "yes", source: "hook-command", liveness: "live" },
  "turn.started": { fulfil: "yes", source: "hook-command", liveness: "live" },
  "turn.ended": { fulfil: "yes", source: "hook-command", liveness: "live" },
  "tool.used": { fulfil: "yes", source: "hook-command", liveness: "live" },
  "prompt.sent": { fulfil: "yes", source: "hook-command", liveness: "live" },
  "usage.reported": { fulfil: "yes", source: "hook-command", liveness: "live" },
};
