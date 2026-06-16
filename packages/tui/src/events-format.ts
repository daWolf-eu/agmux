import type { EventEnvelope } from "@agmux/protocol";

// One line per event for the "events" preview tab: HH:MM:SS kind [summary].
export function eventLines(events: EventEnvelope[]): string[] {
  return events.map((e) => `${e.ts.slice(11, 19)} ${e.kind}${summarize(e)}`);
}

function summarize(e: EventEnvelope): string {
  const p = e.payload as Record<string, unknown> | null;
  if (!p || typeof p !== "object") return "";
  if (e.kind === "tool.used" && typeof p.tool === "string")
    return ` ${p.tool}${typeof p.detail === "string" ? ` ${p.detail}` : ""}`;
  if (e.kind === "input.required" && typeof p.kind === "string") return ` ${p.kind}`;
  return "";
}
