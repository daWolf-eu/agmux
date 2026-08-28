/** @jsxImportSource @opentui/react */
// Confirmed OpenTUI 0.4.1: <box> takes `title` directly + layout/border via style;
// <text> takes `fg` directly; createRoot(renderer).render(...) is correct.
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { PollingSessionFeed } from "../feed.ts";
import { DashApp } from "./DashApp.tsx";
import { activePaneId } from "./attached.ts";
import { tmuxSocketFromEnv } from "@agmux/protocol";
import type { Actions, Handoff, PreviewMode, PreviewSource } from "../types.ts";
import type { ActivityGroup } from "../shared/group.ts";

// One hub query per activity group: `open` polls a small window fast, the
// terminal-heavy groups poll a wide window slowly.
export interface GroupQuery {
  query: URLSearchParams;
  intervalMs: number;
}

export interface RunManageOpts {
  hubUrl: string;
  groupQueries: Record<ActivityGroup, GroupQuery>;
  intervalMs: number;   // preview refresh cadence
  defaultPreview: PreviewMode;
  initialGroup?: ActivityGroup;
  source: PreviewSource;
  actions: Actions;
}

// An empty-argv Handoff means "exit, spawn nothing" (popup attach/resume after
// they retarget the parent client inline).
function resolveHandoff(pending: Handoff | null): Handoff | null {
  return pending && pending.argv.length > 0 ? pending : null;
}

export async function runManage(o: RunManageOpts): Promise<number> {
  // A feed subscribes once, so build a fresh one per group switch.
  const feedFor = (g: ActivityGroup) =>
    new PollingSessionFeed({ hubUrl: o.hubUrl, query: o.groupQueries[g].query, intervalMs: o.groupQueries[g].intervalMs });
  let pending: Handoff | null = null;

  const activePane = await activePaneId();
  const activeSocket = tmuxSocketFromEnv(process.env.TMUX);

  const renderer = await createCliRenderer({
    screenMode: "alternate-screen",
    exitOnCtrlC: true,
    targetFps: 30,
  });

  const destroyed = new Promise<void>((resolve) => renderer.on("destroy", () => resolve()));

  createRoot(renderer).render(
    <DashApp
      feedFor={feedFor}
      source={o.source}
      actions={o.actions}
      hubUrl={o.hubUrl}
      defaultPreview={o.defaultPreview}
      initialGroup={o.initialGroup ?? "open"}
      intervalMs={o.intervalMs}
      activePane={activePane}
      activeSocket={activeSocket}
      onHandoff={(h) => { pending = h; }}
      onQuit={() => renderer.destroy()}
    />,
  );

  await destroyed; // renderer.destroy() restores the terminal (alt-screen, mouse, raw mode)

  const h = resolveHandoff(pending);
  if (h) {
    const child = Bun.spawn(h.argv, { stdio: ["inherit", "inherit", "inherit"], env: h.env ?? process.env });
    await child.exited;
    return child.exitCode ?? 0;
  }
  return 0;
}
