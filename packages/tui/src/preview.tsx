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
  // Max body lines that fit below the fixed tabs/separator header. The body is
  // clipped to this so long output can't scroll the table and header off-screen.
  maxBodyLines?: number;
}

const MODES: PreviewMode[] = ["mirror", "events", "detail"];

// Keep the first `max` lines; collapse the overflow into a single "…" marker so
// the reader can tell output was cut rather than silently ended.
export function clampLines(lines: string[], max: number): string[] {
  if (!Number.isFinite(max) || lines.length <= max) return lines;
  if (max <= 1) return ["…"];
  return [...lines.slice(0, max - 1), "…"];
}

export function Preview({ row, mode, mirrorText, events, usage, maxBodyLines = Infinity }: PreviewProps) {
  const tabs = MODES.map((m) => (m === mode ? `[${m}]` : ` ${m} `)).join(" ");
  return (
    <Box flexDirection="column">
      <Text>{tabs}</Text>
      <Text dimColor>{"─".repeat(40)}</Text>
      {row === null ? <Text dimColor>no session selected</Text> : <Body row={row} mode={mode} mirrorText={mirrorText} events={events} usage={usage} maxBodyLines={maxBodyLines} />}
    </Box>
  );
}

function Body({ row, mode, mirrorText, events, usage, maxBodyLines }: { row: SessionRow; maxBodyLines: number } & Omit<PreviewProps, "row" | "maxBodyLines">) {
  let lines: string[];
  if (mode === "detail") lines = detailLines(row, usage);
  else if (mode === "events") { const e = eventLines(events); lines = e.length ? e : ["no events"]; }
  else lines = (mirrorText || "…").split("\n");
  return <Text>{clampLines(lines, maxBodyLines).join("\n")}</Text>;
}
