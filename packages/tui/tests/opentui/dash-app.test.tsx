/** @jsxImportSource @opentui/react */
import { test, expect } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import type { SessionRow } from "@agmux/protocol";
import type { SessionFeed } from "../../src/feed.ts";
import type { ActivityGroup } from "../../src/shared/group.ts";
import type { Actions, AttachRequest, PreviewSource, UsageSummary } from "../../src/types.ts";
import { DashApp } from "../../src/opentui/DashApp.tsx";
import { mkRow } from "../helpers/mk-row.ts";

// Same rows for every activity group; group-specific feeds are exercised below.
function fakeFeed(rows: SessionRow[]): (g: ActivityGroup) => SessionFeed {
  return () => ({ subscribe(onUpdate, _onError) { onUpdate(rows); return () => {}; } });
}
const noSource: PreviewSource = {
  async mirror() { return ""; },
  async usage(): Promise<UsageSummary | null> { return null; },
};
const noActions: Actions = {
  async attach() { return null; },
  async kill() {},
  async resume() { return { argv: [] }; },
  async copy() {},
  async markSeen() {},
};

test("renders the table and j/k moves the selection", async () => {
  const rows = [
    mkRow({ session_id: "agx-aaaaaaaa1", status: "waiting", tmux_session: "main", tmux_window: "w1" }),
    mkRow({ session_id: "agx-bbbbbbbb2", status: "running", tmux_session: "work", tmux_window: "w2" }),
  ];
  const { renderer, renderOnce, captureCharFrame, mockInput } = await testRender(
    <DashApp
      feedFor={fakeFeed(rows)} source={noSource} actions={noActions}
      hubUrl="http://localhost:0" defaultPreview="mirror" intervalMs={1000} spinnerMs={0}
      onHandoff={() => {}} onQuit={() => {}}
    />,
    { width: 120, height: 30 },
  );
  await renderOnce();

  const frame1 = captureCharFrame();
  // no pane borders / section titles
  expect(frame1).not.toContain("Sessions");
  expect(frame1).not.toContain("┌");
  expect(frame1).toContain("agx-aaaaaaaa1");
  expect(frame1).toContain("agx-bbbbbbbb2");
  const sel1 = frame1.split("\n").find((l) => l.includes("▌"));
  expect(sel1).toContain("agx-aaaaaaaa1");

  await act(async () => { mockInput.pressKey("j"); });
  await renderOnce();
  const frame2 = captureCharFrame();
  const sel2 = frame2.split("\n").find((l) => l.includes("▌"));
  expect(sel2).toContain("agx-bbbbbbbb2");

  renderer.destroy();
});

test("defaults to the status sort, newest first within a status, header row hidden", async () => {
  const rows = [
    mkRow({ session_id: "agx-idle-old", status: "idle", last_heartbeat_ts: "2026-06-22T09:00:00.000Z" }),
    mkRow({ session_id: "agx-idle-new", status: "idle", last_heartbeat_ts: "2026-06-22T11:00:00.000Z" }),
    mkRow({ session_id: "agx-running", status: "running", last_heartbeat_ts: "2026-06-22T08:00:00.000Z" }),
    mkRow({ session_id: "agx-done", status: "done", last_heartbeat_ts: "2026-06-22T07:00:00.000Z" }),
    mkRow({ session_id: "agx-waiting", status: "waiting", last_heartbeat_ts: "2026-06-22T06:00:00.000Z" }),
  ];
  const { renderer, renderOnce, captureCharFrame } = await testRender(
    <DashApp
      feedFor={fakeFeed(rows)} source={noSource} actions={noActions}
      hubUrl="http://localhost:0" defaultPreview="mirror" intervalMs={1000} spinnerMs={0}
      onHandoff={() => {}} onQuit={() => {}}
    />,
    { width: 120, height: 24 },
  );
  await renderOnce();
  const frame = captureCharFrame();
  const lines = frame.split("\n");
  const order = ["agx-waiting", "agx-done", "agx-running", "agx-idle-new", "agx-idle-old"]
    .map((id) => lines.findIndex((l) => l.includes(id)));
  expect(order).toEqual([...order].sort((a, b) => a - b));
  expect(lines.find((l) => l.includes("▌"))).toContain("agx-waiting");
  expect(frame).not.toContain("NAME");
  expect(frame).toContain("[s] sort status▾");
  renderer.destroy();
});

test("showHeader renders column titles with the sort marker; s cycles the visible columns", async () => {
  const rows = [
    mkRow({ session_id: "agx-b", name: "beta", status: "waiting", git_repo: "r" }),
    mkRow({ session_id: "agx-a", name: "alpha", status: "idle", git_repo: "r" }),
  ];
  const { renderer, renderOnce, captureCharFrame, mockInput } = await testRender(
    <DashApp
      feedFor={fakeFeed(rows)} source={noSource} actions={noActions}
      hubUrl="http://localhost:0" defaultPreview="detail" intervalMs={1000} spinnerMs={0}
      columns={["glyph", "name", "repo"]} showHeader
      onHandoff={() => {}} onQuit={() => {}}
    />,
    { width: 120, height: 24 },
  );
  await renderOnce();
  let lines = captureCharFrame().split("\n");
  const header = lines.find((l) => l.includes("NAME"))!;
  expect(header).toContain("REPO");
  expect(header).not.toContain("BRANCH");
  expect(header.trimStart().startsWith("▾")).toBe(true); // glyph column marker

  await act(async () => { mockInput.pressKey("s"); }); // glyph → name (a→z)
  await renderOnce();
  lines = captureCharFrame().split("\n");
  expect(lines.find((l) => l.includes("NAME"))).toMatch(/NAME\s*▴/);
  expect(lines.findIndex((l) => l.includes("alpha"))).toBeLessThan(lines.findIndex((l) => l.includes("beta")));
  expect(captureCharFrame()).toContain("[s] sort name▴");
  renderer.destroy();
});

test("p toggles the preview pane; tab switches mirror ⇄ details", async () => {
  const rows = [
    mkRow({ session_id: "agx-aaa", status: "running", tmux_session: "main", tmux_window: "w1", tmux_pane: "%1" }),
  ];
  const { renderer, renderOnce, captureCharFrame, mockInput } = await testRender(
    <DashApp
      feedFor={fakeFeed(rows)} source={noSource} actions={noActions}
      hubUrl="http://localhost:0" defaultPreview="mirror" intervalMs={1000} spinnerMs={0}
      onHandoff={() => {}} onQuit={() => {}}
    />,
    { width: 120, height: 24 },
  );
  await renderOnce();
  // the sticky-bottom mirror scrollbox settles its scroll position a tick later
  await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
  await renderOnce();
  const shown = captureCharFrame();
  expect(shown).toContain("mirror  detail");
  expect(shown).toContain("no mirror output");
  // a faint vertical rule separates the panes — no box borders
  expect(shown).toContain("│");
  expect(shown).not.toContain("Mirror");

  await act(async () => { mockInput.pressKey("p"); });
  await renderOnce();
  const hidden = captureCharFrame();
  expect(hidden).not.toContain("mirror  detail");
  expect(hidden).not.toContain("│");

  await act(async () => { mockInput.pressKey("p"); });
  await renderOnce();
  expect(captureCharFrame()).toContain("mirror  detail");

  await act(async () => { (mockInput as unknown as { pressTab: () => void }).pressTab(); });
  await renderOnce();
  const det = captureCharFrame();
  expect(det).not.toContain("no mirror output");
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
      feedFor={fakeFeed(rows)} source={noSource} actions={noActions}
      hubUrl="http://localhost:0" defaultPreview="detail" intervalMs={1000} spinnerMs={0}
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
    async copy() {},
    async markSeen() {},
  };

  const closed = [mkRow({ session_id: "agx-closed99", status: "lost" })];
  const r1 = await testRender(
    <DashApp
      feedFor={fakeFeed(closed)} source={noSource} actions={spyActions}
      hubUrl="http://localhost:0" defaultPreview="detail" intervalMs={1000} spinnerMs={0}
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
      feedFor={fakeFeed(live)} source={noSource} actions={spyActions}
      hubUrl="http://localhost:0" defaultPreview="detail" intervalMs={1000} spinnerMs={0}
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

test("y opens the yank popup listing digit-prefixed fields", async () => {
  const rows = [mkRow({ session_id: "agx-yank-1", cwd: "/work/proj" })];
  const { renderer, renderOnce, captureCharFrame, mockInput } = await testRender(
    <DashApp
      feedFor={fakeFeed(rows)} source={noSource} actions={noActions}
      hubUrl="http://localhost:0" defaultPreview="detail" intervalMs={1000} spinnerMs={0}
      onHandoff={() => {}} onQuit={() => {}}
    />,
    { width: 120, height: 30 },
  );
  await renderOnce();
  await act(async () => { mockInput.pressKey("y"); });
  await renderOnce();
  const frame = captureCharFrame();
  expect(frame).toContain("yank field");
  expect(frame).not.toMatch(/[┌┐└┘─]/);
  const lines = frame.split("\n");
  // cursor starts on field 1, marked with the selection bar
  expect(lines.find((l) => l.includes("▌"))).toMatch(/▌ 1\s+Session ID\s+agx-yank-1/);
  expect(frame).toContain("CWD");
  expect(frame).toContain("[1-0/⏎] copy");
  renderer.destroy();
});

test("pressing a digit copies that field and shows a notice", async () => {
  const copied: string[] = [];
  const actions: Actions = { ...noActions, async copy(t) { copied.push(t); } };
  const rows = [mkRow({ session_id: "agx-yank-2", cwd: "/work/proj" })];
  const { renderer, renderOnce, captureCharFrame, mockInput } = await testRender(
    <DashApp
      feedFor={fakeFeed(rows)} source={noSource} actions={actions}
      hubUrl="http://localhost:0" defaultPreview="detail" intervalMs={1000} spinnerMs={0}
      onHandoff={() => {}} onQuit={() => {}}
    />,
    { width: 120, height: 30 },
  );
  await renderOnce();
  await act(async () => { mockInput.pressKey("y"); });
  await renderOnce();
  await act(async () => { mockInput.pressKey("1"); }); // 1 = Session ID
  await renderOnce();
  expect(copied).toEqual(["agx-yank-2"]);
  const frame = captureCharFrame();
  expect(frame).toContain("copied Session ID");
  expect(frame).not.toContain("yank field"); // popup closed
  renderer.destroy();
});

test("yanking an empty field shows an is-empty notice and does not copy", async () => {
  const copied: string[] = [];
  const actions: Actions = { ...noActions, async copy(t) { copied.push(t); } };
  // native_session_id defaults to null -> Native ID (digit 2) is empty.
  const rows = [mkRow({ session_id: "agx-yank-3", native_session_id: null })];
  const { renderer, renderOnce, captureCharFrame, mockInput } = await testRender(
    <DashApp
      feedFor={fakeFeed(rows)} source={noSource} actions={actions}
      hubUrl="http://localhost:0" defaultPreview="detail" intervalMs={1000} spinnerMs={0}
      onHandoff={() => {}} onQuit={() => {}}
    />,
    { width: 120, height: 30 },
  );
  await renderOnce();
  await act(async () => { mockInput.pressKey("y"); });
  await renderOnce();
  await act(async () => { mockInput.pressKey("2"); }); // 2 = Native ID (empty)
  await renderOnce();
  expect(copied).toEqual([]);
  expect(captureCharFrame()).toContain("Native ID is empty");
  renderer.destroy();
});

test("pressing u marks the highlighted row seen", async () => {
  const seen: string[] = [];
  const actions: Actions = { ...noActions, async markSeen(row) { seen.push(row.session_id); } };
  const rows = [mkRow({ session_id: "agx-mark-1", status: "done" })];
  const { renderer, renderOnce, mockInput } = await testRender(
    <DashApp
      feedFor={fakeFeed(rows)} source={noSource} actions={actions}
      hubUrl="http://localhost:0" defaultPreview="detail" intervalMs={1000} spinnerMs={0}
      onHandoff={() => {}} onQuit={() => {}}
    />,
    { width: 120, height: 30 },
  );
  await renderOnce();
  await act(async () => { mockInput.pressKey("u"); });
  await renderOnce();
  expect(seen).toEqual(["agx-mark-1"]);
  renderer.destroy();
});

test("u does not fire while the kill-confirm overlay is open", async () => {
  const seen: string[] = [];
  const actions: Actions = { ...noActions, async markSeen(row) { seen.push(row.session_id); } };
  const rows = [mkRow({ session_id: "agx-mark-2", status: "running" })];
  const { renderer, renderOnce, mockInput } = await testRender(
    <DashApp
      feedFor={fakeFeed(rows)} source={noSource} actions={actions}
      hubUrl="http://localhost:0" defaultPreview="detail" intervalMs={1000} spinnerMs={0}
      onHandoff={() => {}} onQuit={() => {}}
    />,
    { width: 120, height: 30 },
  );
  await renderOnce();
  await act(async () => { mockInput.pressKey("x"); }); // open kill confirm
  await renderOnce();
  await act(async () => { mockInput.pressKey("u"); }); // must be swallowed by the confirm overlay
  await renderOnce();
  expect(seen).toEqual([]);
  renderer.destroy();
});

test("u does not fire while the yank overlay is open", async () => {
  const seen: string[] = [];
  const actions: Actions = { ...noActions, async markSeen(row) { seen.push(row.session_id); } };
  const rows = [mkRow({ session_id: "agx-mark-3" })];
  const { renderer, renderOnce, mockInput } = await testRender(
    <DashApp
      feedFor={fakeFeed(rows)} source={noSource} actions={actions}
      hubUrl="http://localhost:0" defaultPreview="detail" intervalMs={1000} spinnerMs={0}
      onHandoff={() => {}} onQuit={() => {}}
    />,
    { width: 120, height: 30 },
  );
  await renderOnce();
  await act(async () => { mockInput.pressKey("y"); }); // open yank overlay
  await renderOnce();
  await act(async () => { mockInput.pressKey("u"); }); // must be swallowed by the yank overlay
  await renderOnce();
  expect(seen).toEqual([]);
  renderer.destroy();
});

test("escape closes the yank popup without copying", async () => {
  const copied: string[] = [];
  const actions: Actions = { ...noActions, async copy(t) { copied.push(t); } };
  const rows = [mkRow({ session_id: "agx-yank-4" })];
  const { renderer, renderOnce, captureCharFrame, mockInput } = await testRender(
    <DashApp
      feedFor={fakeFeed(rows)} source={noSource} actions={actions}
      hubUrl="http://localhost:0" defaultPreview="detail" intervalMs={1000} spinnerMs={0}
      onHandoff={() => {}} onQuit={() => {}}
    />,
    { width: 120, height: 30 },
  );
  await renderOnce();
  await act(async () => { mockInput.pressKey("y"); });
  await renderOnce();
  expect(captureCharFrame()).toContain("yank field");
  await act(async () => { (mockInput as unknown as { pressEscape: () => void }).pressEscape(); });
  // A lone ESC byte is ambiguous with the start of an arrow-key sequence, so the
  // stdin parser holds it pending for ~20ms before flushing it as "escape".
  await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
  await renderOnce();
  expect(captureCharFrame()).not.toContain("yank field");
  expect(copied).toEqual([]);
  renderer.destroy();
});

test("f re-queries: each activity group subscribes to its own feed", async () => {
  // Rows only the group's own query returns — a client-side filter over the
  // `open` result set could never surface the closed one.
  const perGroup: Record<ActivityGroup, SessionRow[]> = {
    open: [mkRow({ session_id: "agx-live1", status: "running" })],
    closed: [mkRow({ session_id: "agx-dead1", status: "ended" })],
    all: [
      mkRow({ session_id: "agx-live1", status: "running" }),
      mkRow({ session_id: "agx-dead1", status: "ended" }),
    ],
  };
  const subscribed: ActivityGroup[] = [];
  const feedFor = (g: ActivityGroup): SessionFeed => ({
    subscribe(onUpdate) {
      subscribed.push(g);
      onUpdate(perGroup[g]);
      return () => {};
    },
  });

  const { renderer, renderOnce, captureCharFrame, mockInput } = await testRender(
    <DashApp
      feedFor={feedFor} source={noSource} actions={noActions}
      hubUrl="http://localhost:0" defaultPreview="detail" intervalMs={1000} spinnerMs={0}
      onHandoff={() => {}} onQuit={() => {}}
    />,
    { width: 120, height: 30 },
  );
  await renderOnce();
  expect(captureCharFrame()).toContain("agx-live1");

  await act(async () => { mockInput.pressKey("f"); }); // open → closed
  await renderOnce();
  const closedFrame = captureCharFrame();
  expect(closedFrame).toContain("agx-dead1");
  expect(closedFrame).not.toContain("agx-live1");

  await act(async () => { mockInput.pressKey("f"); }); // closed → all
  await renderOnce();
  const allFrame = captureCharFrame();
  expect(allFrame).toContain("agx-live1");
  expect(allFrame).toContain("agx-dead1");

  expect(subscribed).toEqual(["open", "closed", "all"]);
  renderer.destroy();
});

test("the row glyph is ● when done and ○ when idle", async () => {
  const rows = [
    mkRow({ session_id: "agx-unread-01", status: "done" }),
    mkRow({ session_id: "agx-read-0002", status: "idle" }),
  ];
  const { renderer, renderOnce, captureCharFrame } = await testRender(
    <DashApp
      feedFor={fakeFeed(rows)} source={noSource} actions={noActions}
      hubUrl="http://localhost:0" defaultPreview="detail" intervalMs={1000} spinnerMs={0}
      onHandoff={() => {}} onQuit={() => {}}
    />,
    { width: 120, height: 30 },
  );
  await renderOnce();

  const lines = captureCharFrame().split("\n");
  const unreadLine = lines.find((l) => l.includes("agx-unread-01")) ?? "";
  const readLine = lines.find((l) => l.includes("agx-read-0002")) ?? "";
  expect(unreadLine).toContain("●");
  expect(unreadLine).not.toContain("○");
  expect(readLine).toContain("○");
  expect(readLine).not.toContain("●");
  renderer.destroy();
});

test("the help overlay lists every key and the status legend, centred and borderless", async () => {
  const { renderer, renderOnce, captureCharFrame, mockInput } = await testRender(
    <DashApp
      feedFor={fakeFeed([mkRow({ session_id: "agx-help-001" })])} source={noSource} actions={noActions}
      hubUrl="http://localhost:0" defaultPreview="detail" intervalMs={1000} spinnerMs={0}
      onHandoff={() => {}} onQuit={() => {}}
    />,
    { width: 120, height: 30 },
  );
  await renderOnce();
  await act(async () => { mockInput.pressKey("?"); });
  await renderOnce();

  const frame = captureCharFrame();
  for (const legend of ["? waiting", "● done", "⠋ running", "○ idle", "· closed", "· error"]) expect(frame).toContain(legend);
  expect(frame).toContain("needs you");
  // the full key list lives here in the [key] label style, incl. the keys the footer leaves out
  expect(frame).toContain("[g/G] top/bottom");
  expect(frame).toContain("[x]   kill");
  expect(frame).toContain("[u]   mark read");
  expect(frame).toContain("[A]   attach to…");
  expect(frame).toContain("[?/esc] close");
  // borderless and centred on an otherwise empty screen
  expect(frame).not.toMatch(/[┌┐└┘─]/);
  const lines = frame.split("\n");
  const top = lines.findIndex((l) => l.trim() === "keys");
  const bottom = lines.findIndex((l) => l.includes("[?/esc] close"));
  expect(Math.abs(top - (lines.length - 1 - bottom))).toBeLessThanOrEqual(2);
  const indent = lines[top]!.search(/\S/);
  expect(indent).toBeGreaterThan(20);
  renderer.destroy();
});

test("the footer legend shows the everyday keys only, one blank line above it", async () => {
  const { renderer, renderOnce, captureCharFrame } = await testRender(
    <DashApp
      feedFor={fakeFeed([mkRow({ session_id: "agx-foot-01" })])} source={noSource} actions={noActions}
      hubUrl="http://localhost:0" defaultPreview="detail" intervalMs={1000} spinnerMs={0}
      onHandoff={() => {}} onQuit={() => {}}
    />,
    { width: 140, height: 20 },
  );
  await renderOnce();
  const lines = captureCharFrame().split("\n");
  const i = lines.findIndex((l) => l.includes("[⏎] attach"));
  expect(i).toBeGreaterThan(0);
  const footer = lines[i]!;
  for (const hint of ["[A] attach…", "[j/k] move", "[s] sort", "[f] filter", "[/] search", "[y] yank", "[tab] preview", "[p] panel", "[?] help", "[q] quit"])
    expect(footer).toContain(hint);
  for (const hidden of ["top/bottom", "kill", "mark read"]) expect(footer).not.toContain(hidden);
  expect(lines[i - 1]!.trim()).toBe("");
  renderer.destroy();
});

test("a narrow footer drops the least important hints first", async () => {
  const { renderer, renderOnce, captureCharFrame } = await testRender(
    <DashApp
      feedFor={fakeFeed([mkRow({ session_id: "agx-foot-02" })])} source={noSource} actions={noActions}
      hubUrl="http://localhost:0" defaultPreview="detail" intervalMs={1000} spinnerMs={0}
      onHandoff={() => {}} onQuit={() => {}}
    />,
    { width: 80, height: 20 },
  );
  await renderOnce();
  const footer = captureCharFrame().split("\n").find((l) => l.includes("[⏎] attach"))!;
  for (const kept of ["[s] sort", "[?] help", "[q] quit"]) expect(footer).toContain(kept);
  expect(footer).not.toContain("[p] panel");
  expect(footer).not.toContain("[tab] preview");
  renderer.destroy();
});

test("the header summary shows non-zero counts with their glyphs", async () => {
  const rows = [
    mkRow({ session_id: "agx-w1", status: "waiting" }),
    mkRow({ session_id: "agx-w2", status: "waiting" }),
    mkRow({ session_id: "agx-r1", status: "running" }),
  ];
  const { renderer, renderOnce, captureCharFrame } = await testRender(
    <DashApp
      feedFor={fakeFeed(rows)} source={noSource} actions={noActions}
      hubUrl="http://localhost:0" defaultPreview="detail" intervalMs={1000} spinnerMs={0}
      onHandoff={() => {}} onQuit={() => {}}
    />,
    { width: 120, height: 20 },
  );
  await renderOnce();
  const lines = captureCharFrame().split("\n");
  expect(lines[0]).toContain("3 sessions");
  expect(lines[0]).toContain("? 2 waiting");
  expect(lines[0]).toContain("⠋ 1 running");
  expect(lines[0]).not.toContain("done");
  expect(lines[0]).not.toContain("idle");
  expect(lines[1]!.trim()).toBe(""); // spacer between header and panes
  renderer.destroy();
});

test("running rows animate the braille spinner", async () => {
  const rows = [mkRow({ session_id: "agx-spin-01", status: "running" })];
  const { renderer, renderOnce, captureCharFrame } = await testRender(
    <DashApp
      feedFor={fakeFeed(rows)} source={noSource} actions={noActions}
      hubUrl="http://localhost:0" defaultPreview="detail" intervalMs={1000} spinnerMs={10}
      onHandoff={() => {}} onQuit={() => {}}
    />,
    { width: 120, height: 20 },
  );
  await renderOnce();
  const glyphOf = () => captureCharFrame().split("\n").find((l) => l.includes("agx-spin-01"))!.match(/[\u2800-\u28ff]/)?.[0];
  const first = glyphOf();
  expect(first).toBe("⠋");
  await act(async () => { await new Promise((r) => setTimeout(r, 35)); });
  await renderOnce();
  expect(glyphOf()).not.toBe(first);
  renderer.destroy();
});

const TMUX_CTX = { inTmux: true, popup: false, terminalWindow: false, terminalTab: false };

test("A opens the attach popup listing the seven targets, unavailable ones dimmed with a reason", async () => {
  const rows = [mkRow({ session_id: "agx-att-1", status: "running", tmux_session: "m", tmux_window: "@1" })];
  const { renderer, renderOnce, captureCharFrame, mockInput } = await testRender(
    <DashApp
      feedFor={fakeFeed(rows)} source={noSource} actions={noActions} attachCtx={TMUX_CTX}
      hubUrl="http://localhost:0" defaultPreview="detail" intervalMs={1000} spinnerMs={0}
      onHandoff={() => {}} onQuit={() => {}}
    />,
    { width: 120, height: 30 },
  );
  await renderOnce();
  await act(async () => { mockInput.pressKey("A"); });
  await renderOnce();
  const frame = captureCharFrame();
  expect(frame).toContain("attach to");
  expect(frame).not.toMatch(/[┌┐└┘─]/);
  const lines = frame.split("\n");
  expect(lines.find((l) => l.includes("▌"))).toMatch(/▌ 1\s+inline/);
  expect(frame).toMatch(/3\s+new window/);
  expect(frame).toMatch(/5\s+peek\s+planned/);
  expect(frame).toMatch(/7\s+new terminal window\s+not configured/);
  expect(frame).toContain("[1-7/⏎] open");
  renderer.destroy();
});

test("a digit in the attach popup attaches with that placement", async () => {
  const reqs: (AttachRequest | undefined)[] = [];
  const actions: Actions = { ...noActions, async attach(_r, req) { reqs.push(req); return null; } };
  const rows = [mkRow({ session_id: "agx-att-2", status: "running", tmux_session: "m", tmux_window: "@1" })];
  const { renderer, renderOnce, captureCharFrame, mockInput } = await testRender(
    <DashApp
      feedFor={fakeFeed(rows)} source={noSource} actions={actions} attachCtx={TMUX_CTX}
      hubUrl="http://localhost:0" defaultPreview="detail" intervalMs={1000} spinnerMs={0}
      onHandoff={() => {}} onQuit={() => {}}
    />,
    { width: 120, height: 30 },
  );
  await renderOnce();
  await act(async () => { mockInput.pressKey("A"); });
  await renderOnce();
  await act(async () => { mockInput.pressKey("3"); });
  await renderOnce();
  expect(reqs).toEqual([{ placement: "new-window" }]);
  expect(captureCharFrame()).not.toContain("attach to");
  renderer.destroy();
});

test("a closed row resumes through the popup; j + ⏎ picks the next slot", async () => {
  const reqs: (AttachRequest | undefined)[] = [];
  const actions: Actions = { ...noActions, async resume(_r, req) { reqs.push(req); return null; } };
  const rows = [mkRow({ session_id: "agx-att-3", status: "lost" })];
  const { renderer, renderOnce, mockInput } = await testRender(
    <DashApp
      feedFor={fakeFeed(rows)} source={noSource} actions={actions} attachCtx={TMUX_CTX} initialGroup="all"
      hubUrl="http://localhost:0" defaultPreview="detail" intervalMs={1000} spinnerMs={0}
      onHandoff={() => {}} onQuit={() => {}}
    />,
    { width: 120, height: 30 },
  );
  await renderOnce();
  await act(async () => { mockInput.pressKey("A"); });
  await renderOnce();
  await act(async () => { mockInput.pressKey("j"); });
  await renderOnce();
  await act(async () => { (mockInput as unknown as { pressEnter: () => void }).pressEnter(); });
  await renderOnce();
  expect(reqs).toEqual([{ placement: "new-pane" }]);
  renderer.destroy();
});

test("picking a disabled target shows its reason and calls nothing", async () => {
  const calls: string[] = [];
  const actions: Actions = { ...noActions, async attach() { calls.push("attach"); return null; } };
  const rows = [mkRow({ session_id: "agx-att-4", status: "running", tmux_session: "m", tmux_window: "@1" })];
  const { renderer, renderOnce, captureCharFrame, mockInput } = await testRender(
    <DashApp
      feedFor={fakeFeed(rows)} source={noSource} actions={actions}
      hubUrl="http://localhost:0" defaultPreview="detail" intervalMs={1000} spinnerMs={0}
      onHandoff={() => {}} onQuit={() => {}}
    />,
    { width: 120, height: 30 },
  );
  await renderOnce();
  await act(async () => { mockInput.pressKey("A"); });
  await renderOnce();
  await act(async () => { mockInput.pressKey("2"); }); // new pane, no attachCtx → not in tmux
  await renderOnce();
  expect(calls).toEqual([]);
  expect(captureCharFrame()).toContain("new pane: not in tmux");
  renderer.destroy();
});

test("escape closes the attach popup; Enter still uses the default (no request)", async () => {
  const reqs: (AttachRequest | undefined)[] = [];
  const actions: Actions = { ...noActions, async attach(_r, req) { reqs.push(req); return null; } };
  const rows = [mkRow({ session_id: "agx-att-5", status: "running", tmux_session: "m", tmux_window: "@1" })];
  const { renderer, renderOnce, captureCharFrame, mockInput } = await testRender(
    <DashApp
      feedFor={fakeFeed(rows)} source={noSource} actions={actions} attachCtx={TMUX_CTX}
      hubUrl="http://localhost:0" defaultPreview="detail" intervalMs={1000} spinnerMs={0}
      onHandoff={() => {}} onQuit={() => {}}
    />,
    { width: 120, height: 30 },
  );
  await renderOnce();
  await act(async () => { mockInput.pressKey("A"); });
  await renderOnce();
  await act(async () => { (mockInput as unknown as { pressEscape: () => void }).pressEscape(); });
  // A lone ESC is held ~20ms by the stdin parser before it flushes as "escape".
  await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
  await renderOnce();
  expect(captureCharFrame()).not.toContain("attach to");
  await act(async () => { (mockInput as unknown as { pressEnter: () => void }).pressEnter(); });
  await renderOnce();
  expect(reqs).toEqual([undefined]);
  renderer.destroy();
});
