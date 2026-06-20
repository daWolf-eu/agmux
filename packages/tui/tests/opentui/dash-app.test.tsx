/** @jsxImportSource @opentui/react */
import { test, expect } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import type { SessionRow, EventEnvelope } from "@agmux/protocol";
import type { SessionFeed } from "../../src/feed.ts";
import type { Actions, PreviewSource, UsageSummary } from "../../src/types.ts";
import { DashApp } from "../../src/opentui/DashApp.tsx";
import { mkRow } from "../helpers/mk-row.ts";

function fakeFeed(rows: SessionRow[]): SessionFeed {
  return { subscribe(onUpdate, _onError) { onUpdate(rows); return () => {}; } };
}
const noSource: PreviewSource = {
  async mirror() { return ""; },
  async events(): Promise<EventEnvelope[]> { return []; },
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
  const sel1 = frame1.split("\n").find((l) => l.includes("▶"));
  expect(sel1).toContain("agx-aaaaaaaa1");

  await act(async () => { mockInput.pressKey("j"); });
  await renderOnce();
  const frame2 = captureCharFrame();
  const sel2 = frame2.split("\n").find((l) => l.includes("▶"));
  expect(sel2).toContain("agx-bbbbbbbb2");

  renderer.destroy();
});
