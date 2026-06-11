import React, { useEffect, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import type { SessionRow } from "@agmux/protocol";
import type { SessionFeed } from "./feed.ts";
import { SessionTable } from "./session-table.tsx";

export interface WatchAppProps {
  feed: SessionFeed;
  reverse: boolean;
  hubUrl: string;
  clock?: () => string; // injected in tests; defaults to wall-clock HH:MM:SS
}

export function WatchApp({ feed, reverse, hubUrl, clock }: WatchAppProps) {
  const { exit } = useApp();
  const now = clock ?? (() => new Date().toTimeString().slice(0, 8));
  const [rows, setRows] = useState<SessionRow[] | null>(null); // null = nothing received yet
  const [error, setError] = useState<string | null>(null);
  const [refreshedAt, setRefreshedAt] = useState("");

  useInput((input) => { if (input === "q") exit(); });

  // subscribe() returns its own unsubscribe — exactly the effect cleanup shape.
  useEffect(() => feed.subscribe(
    (r) => { setRows(r); setError(null); setRefreshedAt(now()); },
    (e) => setError(e.message),
  ), [feed]);

  return (
    <Box flexDirection="column">
      {rows === null
        ? <Text dimColor>connecting to {hubUrl}…</Text>
        : <SessionTable rows={rows} reverse={reverse} />}
      <Text dimColor>
        {error
          ? `hub unreachable — reconnecting… (${error})`
          : `${rows?.length ?? 0} sessions · refreshed ${refreshedAt} · q to quit`}
      </Text>
    </Box>
  );
}
