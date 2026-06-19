import React from "react";
import { Box, Text } from "ink";
import type { SessionRow, EventEnvelope } from "@agmux/protocol";
import type { PreviewMode, UsageSummary } from "./types.ts";
import { detailLines } from "./detail.ts";
import { eventLines } from "./events-format.ts";

export interface PreviewProps {
  row: SessionRow | null;
  mode: PreviewMode;          // already resolved (caller applies mirror→events fallback)
  mirrorText: string;
  events: EventEnvelope[];
  usage: UsageSummary | null;
  // Max *physical* rows the body may occupy (after wrapping). The body is clamped
  // to its newest tail to fit, and the whole frame is kept strictly under the
  // viewport so Ink never full-clears the screen (its flicker path).
  maxBodyLines?: number;
  // Column width in chars. Lines wider than this are hard-wrapped (not truncated)
  // so the full content stays readable, and the wrapped row count is exact — which
  // lets us bound the body height precisely. Mirror text is plain (capture-pane -p).
  bodyWidth?: number;
}

const MODES: PreviewMode[] = ["mirror", "events", "detail"];

// Keep the last `max` lines; collapse the clipped top into a single "…" marker.
// The newest output sits at the bottom, so we drop from the top to keep the
// most relevant tail visible while still signalling that earlier lines were cut.
export function clampLines(lines: string[], max: number): string[] {
  if (!Number.isFinite(max) || lines.length <= max) return lines;
  if (max <= 1) return ["…"];
  return ["…", ...lines.slice(lines.length - (max - 1))];
}

// Hard-truncate a single line to `width` with a trailing "…" when it overflows.
// Used for structured rows (the table, the tab header) where wrapping would break
// column alignment — content panes should wrap instead (see hardWrap).
export function truncateLine(line: string, width: number): string {
  if (!Number.isFinite(width) || line.length <= width) return line;
  if (width <= 1) return "…";
  return line.slice(0, width - 1) + "…";
}

// Break one logical line into width-sized physical rows (character wrap). Keeps
// all content visible (unlike truncation) while making the rendered row count
// exact, so the body height can be bounded reliably.
function hardWrap(line: string, width: number): string[] {
  if (!Number.isFinite(width) || width <= 0 || line.length <= width) return [line];
  const out: string[] = [];
  for (let i = 0; i < line.length; i += width) out.push(line.slice(i, i + width));
  return out;
}

// Wrap each logical line to `width`, then keep the newest `maxRows` physical rows
// (with a top "…" marker when clipped). No padding: a short body renders short, so
// while navigating (empty preview) the frame stays small and cheap to repaint.
export function fitBody(lines: string[], maxRows: number, width: number): string[] {
  const physical = lines.flatMap((l) => hardWrap(l, width));
  return clampLines(physical, maxRows);
}

function PreviewImpl({ row, mode, mirrorText, events, usage, maxBodyLines = Infinity, bodyWidth = Infinity }: PreviewProps) {
  const tabs = MODES.map((m) => (m === mode ? `[${m}]` : ` ${m} `)).join(" ");
  return (
    <Box flexDirection="column">
      <Text>{truncateLine(tabs, bodyWidth)}</Text>
      <Text dimColor>{"─".repeat(Math.min(40, Number.isFinite(bodyWidth) ? bodyWidth : 40))}</Text>
      {row === null ? <Text dimColor>no session selected</Text> : <Body row={row} mode={mode} mirrorText={mirrorText} events={events} usage={usage} maxBodyLines={maxBodyLines} bodyWidth={bodyWidth} />}
    </Box>
  );
}

// Memoized: re-renders only when its own props change, so a cursor move that
// leaves the selected row's preview untouched doesn't re-render the body.
export const Preview = React.memo(PreviewImpl);

function Body({ row, mode, mirrorText, events, usage, maxBodyLines, bodyWidth }: { row: SessionRow; maxBodyLines: number; bodyWidth: number } & Omit<PreviewProps, "row" | "maxBodyLines" | "bodyWidth">) {
  let lines: string[];
  if (mode === "detail") lines = detailLines(row, usage);
  else if (mode === "events") { const e = eventLines(events); lines = e.length ? e : ["no events"]; }
  else lines = (mirrorText || "…").split("\n");
  return <Text>{fitBody(lines, maxBodyLines, bodyWidth).join("\n")}</Text>;
}
