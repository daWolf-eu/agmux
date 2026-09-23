import React from "react";
import { render } from "ink";
import { PollingSessionFeed, type HubUrlSource } from "./feed.ts";
import { WatchApp } from "./watch-app.tsx";

export interface RunWatchOpts {
  hubUrl: string;              // display only
  // Re-resolved per poll so the view survives a hub restart (see HubUrlSource).
  resolveHubUrl?: HubUrlSource;
  query: URLSearchParams;
  intervalMs: number;
  reverse: boolean;
}

export async function runWatch(o: RunWatchOpts): Promise<number> {
  const feed = new PollingSessionFeed({ hubUrl: o.resolveHubUrl ?? o.hubUrl, query: o.query, intervalMs: o.intervalMs });
  process.stdout.write("\x1b[?1049h\x1b[H"); // enter alt screen, home cursor
  try {
    const app = render(<WatchApp feed={feed} reverse={o.reverse} hubUrl={o.hubUrl} />, { exitOnCtrlC: true });
    await app.waitUntilExit();
  } finally {
    process.stdout.write("\x1b[?1049l"); // restore the user's screen even on throw
  }
  return 0;
}
