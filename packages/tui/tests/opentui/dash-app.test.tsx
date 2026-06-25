/** @jsxImportSource @opentui/react */
import { test, expect } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import type { SessionRow } from "@agmux/protocol";
import type { SessionFeed } from "../../src/feed.ts";
import type { Actions, PreviewSource, UsageSummary } from "../../src/types.ts";
import { DashApp } from "../../src/opentui/DashApp.tsx";
import { mkRow } from "../helpers/mk-row.ts";

function fakeFeed(rows: SessionRow[]): SessionFeed {
  return { subscribe(onUpdate, _onError) { onUpdate(rows); return () => {}; } };
}
const noSource: PreviewSource = {
  async mirror() { return ""; },
  async usage(): Promise<UsageSummary | null> { return null; },
};
const noActions: Actions = {
  async attach() { return null; },
  async kill() {},
  async resume() { return { argv: [] }; },
};

test("renders the table and j/k moves the selection", async () => {
  const rows = [
    mkRow({ session_id: "agx-aaaaaaaa1", status: "waiting", tmux_session: "main", tmux_window: "w1" }),
    mkRow({ session_id: "agx-bbbbbbbb2", status: "running", tmux_session: "work", tmux_window: "w2" }),
  ];
  const { renderer, renderOnce, captureCharFrame, mockInput } = await testRender(
    <DashApp
      feed={fakeFeed(rows)} source={noSource} actions={noActions}
      hubUrl="http://localhost:0" defaultPreview="mirror" intervalMs={1000}
      onHandoff={() => {}} onQuit={() => {}}
    />,
    { width: 120, height: 30 },
  );
  await renderOnce();

  const frame1 = captureCharFrame();
  expect(frame1).toContain("Sessions");
  expect(frame1).toContain("agx-aaaaaaaa1");
  expect(frame1).toContain("agx-bbbbbbbb2");
  const sel1 = frame1.split("\n").find((l) => l.includes("›"));
  expect(sel1).toContain("agx-aaaaaaaa1");

  await act(async () => { mockInput.pressKey("j"); });
  await renderOnce();
  const frame2 = captureCharFrame();
  const sel2 = frame2.split("\n").find((l) => l.includes("›"));
  expect(sel2).toContain("agx-bbbbbbbb2");

  renderer.destroy();
});

test("defaults to newest-first (last) sort with a header indicator", async () => {
  const rows = [
    mkRow({ session_id: "agx-older", status: "idle", last_heartbeat_ts: "2026-06-22T09:00:00.000Z" }),
    mkRow({ session_id: "agx-newer", status: "idle", last_heartbeat_ts: "2026-06-22T11:00:00.000Z" }),
  ];
  const { renderer, renderOnce, captureCharFrame } = await testRender(
    <DashApp
      feed={fakeFeed(rows)} source={noSource} actions={noActions}
      hubUrl="http://localhost:0" defaultPreview="mirror" intervalMs={1000}
      onHandoff={() => {}} onQuit={() => {}}
    />,
    { width: 120, height: 24 },
  );
  await renderOnce();
  const lines = captureCharFrame().split("\n");
  // active sort marker rides on the LAST column header
  expect(lines.find((l) => l.includes("LAST"))).toContain("▾");
  // newest is selected and sits above the older row
  expect(lines.find((l) => l.includes("›"))).toContain("agx-newer");
  expect(lines.findIndex((l) => l.includes("agx-newer")))
    .toBeLessThan(lines.findIndex((l) => l.includes("agx-older")));
  renderer.destroy();
});

test("p toggles the preview pane; tab switches mirror ⇄ details", async () => {
  const rows = [
    mkRow({ session_id: "agx-aaa", status: "running", tmux_session: "main", tmux_window: "w1", tmux_pane: "%1" }),
  ];
  const { renderer, renderOnce, captureCharFrame, mockInput } = await testRender(
    <DashApp
      feed={fakeFeed(rows)} source={noSource} actions={noActions}
      hubUrl="http://localhost:0" defaultPreview="mirror" intervalMs={1000}
      onHandoff={() => {}} onQuit={() => {}}
    />,
    { width: 120, height: 24 },
  );
  await renderOnce();
  expect(captureCharFrame()).toContain("Mirror");

  await act(async () => { mockInput.pressKey("p"); });
  await renderOnce();
  const hidden = captureCharFrame();
  expect(hidden).not.toContain("Mirror");
  expect(hidden).not.toContain("Details");

  await act(async () => { mockInput.pressKey("p"); });
  await renderOnce();
  expect(captureCharFrame()).toContain("Mirror");

  await act(async () => { (mockInput as unknown as { pressTab: () => void }).pressTab(); });
  await renderOnce();
  const det = captureCharFrame();
  expect(det).toContain("Details");
  expect(det).toContain("Created");
  // ISO timestamp shown in the detail view (value may wrap in the narrow panel)
  expect(det).toContain("2026-06-20T10:00:00");
  renderer.destroy();
});

test("f cycles the activity group; closed sessions are hidden until shown", async () => {
  const rows = [
    mkRow({ session_id: "agx-open111", status: "running", tmux_session: "main", tmux_window: "w1" }),
    mkRow({ session_id: "agx-closed22", status: "ended" }),
  ];
  const { renderer, renderOnce, captureCharFrame, mockInput } = await testRender(
    <DashApp
      feed={fakeFeed(rows)} source={noSource} actions={noActions}
      hubUrl="http://localhost:0" defaultPreview="detail" intervalMs={1000}
      onHandoff={() => {}} onQuit={() => {}}
    />,
    { width: 120, height: 24 },
  );
  await renderOnce();
  // default group is "open": closed row hidden, open row shown
  expect(captureCharFrame()).toContain("agx-open111");
  expect(captureCharFrame()).not.toContain("agx-closed22");

  await act(async () => { mockInput.pressKey("f"); }); // -> closed
  await renderOnce();
  expect(captureCharFrame()).toContain("agx-closed22");
  expect(captureCharFrame()).not.toContain("agx-open111");

  await act(async () => { mockInput.pressKey("f"); }); // -> all
  await renderOnce();
  expect(captureCharFrame()).toContain("agx-open111");
  expect(captureCharFrame()).toContain("agx-closed22");

  renderer.destroy();
});

test("Enter on a closed session resumes; Enter on a live session attaches", async () => {
  const calls: string[] = [];
  const spyActions: Actions = {
    async attach() { calls.push("attach"); return null; },
    async kill() {},
    async resume() { calls.push("resume"); return { argv: [] }; },
  };

  const closed = [mkRow({ session_id: "agx-closed99", status: "lost" })];
  const r1 = await testRender(
    <DashApp
      feed={fakeFeed(closed)} source={noSource} actions={spyActions}
      hubUrl="http://localhost:0" defaultPreview="detail" intervalMs={1000}
      initialGroup="all" onHandoff={() => {}} onQuit={() => {}}
    />,
    { width: 120, height: 24 },
  );
  await r1.renderOnce();
  await act(async () => { (r1.mockInput as unknown as { pressEnter: () => void }).pressEnter(); });
  await r1.renderOnce();
  expect(calls).toEqual(["resume"]);
  r1.renderer.destroy();

  calls.length = 0;
  const live = [mkRow({ session_id: "agx-live01", status: "running", tmux_session: "m", tmux_window: "w" })];
  const r2 = await testRender(
    <DashApp
      feed={fakeFeed(live)} source={noSource} actions={spyActions}
      hubUrl="http://localhost:0" defaultPreview="detail" intervalMs={1000}
      onHandoff={() => {}} onQuit={() => {}}
    />,
    { width: 120, height: 24 },
  );
  await r2.renderOnce();
  await act(async () => { (r2.mockInput as unknown as { pressEnter: () => void }).pressEnter(); });
  await r2.renderOnce();
  expect(calls).toEqual(["attach"]);
  r2.renderer.destroy();
});
