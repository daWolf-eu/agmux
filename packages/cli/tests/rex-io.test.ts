import { test, expect } from "bun:test";
import type { SessionRow } from "@agmux/protocol";
import { rexTail, rexTitle, RexPoll, rexPrimitives } from "../src/rex-io.ts";
import { makePreviewSource } from "../src/dash-preview.ts";
import { fakeRex } from "./helpers/fake-rex.ts";

const row = { tmux_session: "session:s1", tmux_pane: "block:b1", tmux_socket: "unix:///x" };
const S = "-s session:s1 -b block:b1";
const fmt = (n: number) => `block call format ${JSON.stringify({ format: "text", max_bytes: n })} ${S}`;
const rd = (id: number, offset: number, n: number) => `block call blob_read ${JSON.stringify({ id, offset, max_bytes: n })} ${S}`;
const G = ["--autostart=false", "-S", "unix:///x", "--timeout"];

test("rexTail under maxBytes returns content from one format call", async () => {
  const exec = fakeRex({ [fmt(100)]: { stdout: JSON.stringify({ content: "hello", total: 5 }) } });
  expect(await rexTail(row, 100, exec)).toBe("hello");
  expect(exec.calls.length).toBe(1);
  expect(exec.calls[0]!.slice(0, 3)).toEqual(G.slice(0, 3));
  expect(exec.calls[0]).toContain("--timeout");
});

test("rexTail over maxBytes calls blob_read at total - maxBytes and returns only the tail", async () => {
  const exec = fakeRex({
    [fmt(4)]: { stdout: JSON.stringify({ content: "head", id: 7, total: 10 }) },
    [rd(7, 6, 4)]: { stdout: JSON.stringify({ id: 7, data: "tail", total: 10, eof: true }) },
  });
  expect(await rexTail(row, 4, exec)).toBe("tail");
});

test("rexTail loops blob_read until eof, because a reply can be shorter than max_bytes", async () => {
  const exec = fakeRex({
    [fmt(6)]: { stdout: JSON.stringify({ content: "head", id: 7, total: 16 }) },
    [rd(7, 10, 6)]: { stdout: JSON.stringify({ id: 7, data: "abc", total: 16, eof: false }) },
    [rd(7, 13, 6)]: { stdout: JSON.stringify({ id: 7, data: "def", total: 16, eof: true }) },
  });
  expect(await rexTail(row, 6, exec)).toBe("abcdef");
});

test("rexTail drops a leading replacement char from a split multi-byte character", async () => {
  const exec = fakeRex({
    [fmt(4)]: { stdout: JSON.stringify({ content: "h", id: 7, total: 10 }) },
    [rd(7, 6, 4)]: { stdout: JSON.stringify({ id: 7, data: "�abc", total: 10, eof: true }) },
  });
  expect(await rexTail(row, 4, exec)).toBe("abc");
});

test("rexTail on any failure returns an empty string", async () => {
  expect(await rexTail(row, 100, fakeRex({}))).toBe("");
  expect(await rexTail(row, 100, fakeRex({ [fmt(100)]: { stdout: "not json" } }))).toBe("");
  const bad = fakeRex({
    [fmt(4)]: { stdout: JSON.stringify({ content: "head", id: 7, total: 10 }) },
  });
  expect(await rexTail(row, 4, bad)).toBe("");
  const throwing = (async () => { throw new Error("x"); }) as any;
  expect(await rexTail(row, 100, throwing)).toBe("");
});

test("rexTail never calls rex capture", async () => {
  const exec = fakeRex({ [fmt(4)]: { stdout: JSON.stringify({ content: "head", id: 7, total: 10 }) } });
  await rexTail(row, 4, exec);
  expect(exec.calls.flat()).not.toContain("capture");
});

test("rexTitle returns the title or null", async () => {
  const ok = fakeRex({ [`block call title ${S}`]: { stdout: JSON.stringify({ title: "vim" }) } });
  expect(await rexTitle(row, ok)).toBe("vim");
  expect(await rexTitle(row, fakeRex({}))).toBeNull();
});

test("RexPoll backs off to 1000 ms after a 300 ms read and recovers after a fast one", () => {
  const p = new RexPoll();
  expect(p.delayMs("b", 500)).toBe(500);
  p.record("b", 300);
  expect(p.delayMs("b", 500)).toBe(1000);
  expect(p.delayMs("b", 2000)).toBe(2000);
  p.record("b", 20);
  expect(p.delayMs("b", 500)).toBe(500);
});

function mkRow(over: Partial<SessionRow> = {}): SessionRow {
  return {
    tmux_server: null, mux: null, mux_label: null,
    session_id: "s1", agent_kind: "claude", profile: null, native_session_id: null,
    command: "claude", args: [], env_overrides: {}, cwd: "/tmp", pid: 1,
    tmux_session: "session:s1", tmux_window: "window:w1", tmux_pane: "block:b1", tmux_socket: "unix:///x", host: "h", project: null,
    parent_session_id: null, start_ts: "2026-06-11T10:00:00.000Z", last_heartbeat_ts: null,
    end_ts: null, exit_code: null, signal: null, status: "running", origin: "native",
    turn_count: null, last_tool: null, last_tool_detail: null, last_input_kind: null, activity_ts: null, ...over,
  };
}

test("mirror on a rex row calls rexTail, not tmux", async () => {
  const exec = fakeRex({ [fmt(65536)]: { stdout: JSON.stringify({ content: "rexout", total: 6 }) } });
  let tmuxCalled = false;
  const src = makePreviewSource("http://h", async () => { tmuxCalled = true; return "t"; }, exec);
  expect(await src.mirror(mkRow({ mux: "rex" }))).toBe("rexout");
  expect(tmuxCalled).toBe(false);
});

test("mirror on a tmux row is unchanged", async () => {
  const exec = fakeRex({});
  const src = makePreviewSource("http://h", async (a) => `ran ${a.join(" ")}`, exec);
  expect(await src.mirror(mkRow({ mux: null, tmux_pane: "%1", tmux_socket: null }))).toBe("ran capture-pane -p -t %1");
  expect(exec.calls.length).toBe(0);
});

test("rexTail multi-chunk: stray U+FFFD at the start of each chunk are dropped and counted as 1 byte", async () => {
  // offset 10 falls inside a 3-byte char: 2 stray bytes -> two U+FFFD (6 encoded bytes, 2 real).
  const exec = fakeRex({
    [fmt(8)]: { stdout: JSON.stringify({ content: "head", id: 7, total: 18 }) },
    [rd(7, 10, 8)]: { stdout: JSON.stringify({ id: 7, data: "\uFFFD\uFFFDab", total: 18, eof: false }) },
    [rd(7, 14, 8)]: { stdout: JSON.stringify({ id: 7, data: "cdef", total: 18, eof: true }) },
  });
  expect(await rexTail(row, 8, exec)).toBe("abcdef");
});

const prim = { session: "session:s1", socket: "unix:///x" };

test("rexPrimitives.clearLine sends ctrl+a then ctrl+k", async () => {
  const exec = fakeRex({ "block send-key -s session:s1 -b block:b1 ctrl+a ctrl+k": { stdout: "" } });
  await rexPrimitives(prim, exec).clearLine("block:b1");
  expect(exec.calls.length).toBe(1);
  expect(exec.calls[0]!.slice(0, 3)).toEqual(G.slice(0, 3));
  expect(exec.calls[0]).toContain("--timeout");
});

test("rexPrimitives.submit sends enter", async () => {
  const exec = fakeRex({ "block send-key -s session:s1 -b block:b1 enter": {} });
  await rexPrimitives(prim, exec).submit("block:b1");
  expect(exec.calls.length).toBe(1);
});

test("rexPrimitives.paste sends block.event paste through stdin, not argv", async () => {
  const text = "line1\nline2\n" + "x".repeat(20_000);
  const exec = fakeRex({ "api call -s session:s1 block.event -": { stdout: "{}" } });
  await rexPrimitives(prim, exec).paste("block:b1", new TextEncoder().encode(text));
  expect(exec.calls.length).toBe(1);
  expect(exec.calls[0]!.slice(0, 3)).toEqual(G.slice(0, 3));
  expect(exec.calls[0]).toContain("--timeout");
  expect(exec.calls[0]!.some((a) => a.includes("line1"))).toBe(false);
  const j = JSON.parse(new TextDecoder().decode(exec.stdins[0]!));
  expect(j).toEqual({ session_id: "session:s1", block_id: "block:b1", event: { type: "paste", payload: { text } } });
});

test("rexPrimitives rejects when rex fails", async () => {
  const exec = fakeRex({});
  await expect(rexPrimitives(prim, exec).submit("block:b1")).rejects.toThrow();
});

test("rexPrimitives.capture reads the block tail", async () => {
  const exec = fakeRex({ [`block call format ${JSON.stringify({ format: "text", max_bytes: 16384 })} ${S}`]: { stdout: JSON.stringify({ content: "hi", total: 2 }) } });
  expect(await rexPrimitives(prim, exec).capture("block:b1")).toBe("hi");
});
