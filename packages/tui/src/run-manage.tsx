import React from "react";
import { render } from "ink";
import { PollingSessionFeed } from "./feed.ts";
import { ManageApp } from "./manage-app.tsx";
import type { Actions, Handoff, PreviewMode, PreviewSource } from "./types.ts";

export interface RunManageOpts {
  hubUrl: string;
  query: URLSearchParams;
  intervalMs: number;
  defaultPreview: PreviewMode;
  source: PreviewSource;
  actions: Actions;
}

// A Handoff with an empty argv is the "exit dash, spawn nothing" sentinel
// (used by popup-mode attach/resume after they retarget the parent client).
// Returns the Handoff to run, or null when nothing should run.
export function resolveHandoff(pending: Handoff | null): Handoff | null {
  return pending && pending.argv.length > 0 ? pending : null;
}

export async function runManage(o: RunManageOpts): Promise<number> {
  const feed = new PollingSessionFeed({ hubUrl: o.hubUrl, query: o.query, intervalMs: o.intervalMs });
  let pending: Handoff | null = null;
  process.stdout.write("\x1b[?1049h\x1b[H"); // enter alt screen, home cursor
  try {
    const app = render(
      <ManageApp
        feed={feed} source={o.source} actions={o.actions} hubUrl={o.hubUrl}
        defaultPreview={o.defaultPreview} intervalMs={o.intervalMs}
        onHandoff={(h) => { pending = h; }}
      />,
      { exitOnCtrlC: true },
    );
    await app.waitUntilExit();
  } finally {
    process.stdout.write("\x1b[?1049l"); // restore the user's screen even on throw
  }
  const h = resolveHandoff(pending);
  if (h) {
    const child = Bun.spawn(h.argv, { stdio: ["inherit", "inherit", "inherit"], env: h.env ?? process.env });
    await child.exited;
    return child.exitCode ?? 0;
  }
  return 0;
}
