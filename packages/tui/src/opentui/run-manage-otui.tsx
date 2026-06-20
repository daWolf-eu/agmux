/** @jsxImportSource @opentui/react */
// Confirmed OpenTUI 0.4.1: <box> takes `title` directly + layout/border via style;
// <text> takes `fg` directly; createRoot(renderer).render(...) is correct.
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { PollingSessionFeed } from "../feed.ts";
import { DashApp } from "./DashApp.tsx";
import type { RunManageOpts } from "../run-manage.tsx";
import type { Handoff } from "../types.ts";

// An empty-argv Handoff means "exit, spawn nothing" (popup attach/resume after
// they retarget the parent client inline). Same sentinel as the Ink entry.
function resolveHandoff(pending: Handoff | null): Handoff | null {
  return pending && pending.argv.length > 0 ? pending : null;
}

export async function runManageOtui(o: RunManageOpts): Promise<number> {
  const feed = new PollingSessionFeed({ hubUrl: o.hubUrl, query: o.query, intervalMs: o.intervalMs });
  let pending: Handoff | null = null;

  const renderer = await createCliRenderer({
    screenMode: "alternate-screen",
    exitOnCtrlC: true,
    targetFps: 30,
  });

  const destroyed = new Promise<void>((resolve) => renderer.on("destroy", () => resolve()));

  createRoot(renderer).render(
    <DashApp
      feed={feed}
      source={o.source}
      actions={o.actions}
      hubUrl={o.hubUrl}
      defaultPreview={o.defaultPreview}
      intervalMs={o.intervalMs}
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
