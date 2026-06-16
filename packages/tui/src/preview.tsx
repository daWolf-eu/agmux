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
}

const MODES: PreviewMode[] = ["mirror", "events", "detail"];

export function Preview({ row, mode, mirrorText, events, usage }: PreviewProps) {
  const tabs = MODES.map((m) => (m === mode ? `[${m}]` : ` ${m} `)).join(" ");
  return (
    <Box flexDirection="column">
      <Text>{tabs}</Text>
      <Text dimColor>{"─".repeat(40)}</Text>
      {row === null ? <Text dimColor>no session selected</Text> : <Body row={row} mode={mode} mirrorText={mirrorText} events={events} usage={usage} />}
    </Box>
  );
}

function Body({ row, mode, mirrorText, events, usage }: { row: SessionRow } & Omit<PreviewProps, "row">) {
  if (mode === "detail") return <Text>{detailLines(row, usage).join("\n")}</Text>;
  if (mode === "events") {
    const lines = eventLines(events);
    return <Text>{lines.length ? lines.join("\n") : "no events"}</Text>;
  }
  return <Text>{mirrorText || "…"}</Text>;
}
