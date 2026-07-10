import { test, expect } from "bun:test";
import { buildAttachCommands, decideAttach } from "../src/attach.ts";
import type { SessionRow } from "@agmux/protocol";

const coords = { tmux_session: "agmux", tmux_window: "@4", tmux_pane: "%3", tmux_socket: null };

function sessionRow(over: Partial<SessionRow> = {}): SessionRow {
  return {
    session_id: "019f1898-8e0f-7000-ab55-07d09f673b59",
    agent_kind: "claude", profile: "claude-work", native_session_id: "n1",
    command: "claude", args: [], env_overrides: {}, cwd: "/tmp", pid: 18219,
    tmux_session: "gone-session", tmux_window: "@198", tmux_pane: "%330", tmux_socket: null,
    host: "h", project: null, parent_session_id: null,
    start_ts: "2026-06-30T12:54:38.836Z", last_heartbeat_ts: "2026-06-30T13:28:05.225Z",
    end_ts: null, exit_code: null, signal: null, status: "idle", origin: "native",
    ...over,
  };
}

test("decideAttach: live status + existing tmux session → attach", async () => {
  const d = await decideAttach(sessionRow({ status: "idle" }), async () => true);
  expect(d).toBe("attach");
});

test("decideAttach: live status but tmux session gone → resume (stale-live)", async () => {
  // The reported bug: an idle/native row pinned live by pid reuse whose tmux
  // session no longer exists must fall back to resume, not blindly attach.
  const d = await decideAttach(sessionRow({ status: "idle" }), async () => false);
  expect(d).toBe("resume");
});

test("decideAttach: terminal status → resume without probing tmux", async () => {
  let probed = false;
  const d = await decideAttach(sessionRow({ status: "lost" }), async () => { probed = true; return true; });
  expect(d).toBe("resume");
  expect(probed).toBe(false);
});

test("decideAttach: live status but missing tmux coords → resume", async () => {
  const d = await decideAttach(sessionRow({ status: "running", tmux_window: null }), async () => true);
  expect(d).toBe("resume");
});

test("decideAttach: probes existence on the session's own socket", async () => {
  const seen: Array<[string, string | null]> = [];
  await decideAttach(
    sessionRow({ status: "waiting", tmux_session: "s", tmux_socket: "/sock" }),
    async (name, socket) => { seen.push([name, socket]); return true; },
  );
  expect(seen).toEqual([["s", "/sock"]]);
});

test("inTmux: switches window then selects the session's own pane", () => {
  expect(buildAttachCommands(coords, true)).toEqual([
    ["switch-client", "-t", "agmux:@4"],
    ["select-pane", "-t", "%3"],
  ]);
});

test("inTmux: window-only fallback when no pane stored", () => {
  expect(buildAttachCommands({ ...coords, tmux_pane: null }, true)).toEqual([
    ["switch-client", "-t", "agmux:@4"],
  ]);
});

test("not inTmux: one chained attach that selects window and pane", () => {
  expect(buildAttachCommands(coords, false)).toEqual([
    ["attach-session", "-t", "agmux", ";", "select-window", "-t", "agmux:@4", ";", "select-pane", "-t", "%3"],
  ]);
});

test("not inTmux: window-only fallback when no pane stored", () => {
  expect(buildAttachCommands({ ...coords, tmux_pane: null }, false)).toEqual([
    ["attach-session", "-t", "agmux", ";", "select-window", "-t", "agmux:@4"],
  ]);
});

test("inTmux: prefixes -S socket on each command when tmux_socket set", () => {
  expect(buildAttachCommands({ ...coords, tmux_socket: "/sock" }, true)).toEqual([
    ["-S", "/sock", "switch-client", "-t", "agmux:@4"],
    ["-S", "/sock", "select-pane", "-t", "%3"],
  ]);
});

test("not inTmux: prefixes -S socket on the chained attach when tmux_socket set", () => {
  expect(buildAttachCommands({ ...coords, tmux_socket: "/sock" }, false)).toEqual([
    ["-S", "/sock", "attach-session", "-t", "agmux", ";", "select-window", "-t", "agmux:@4", ";", "select-pane", "-t", "%3"],
  ]);
});

test("omits -S when tmux_socket is null", () => {
  expect(buildAttachCommands(coords, true)[0]!.slice(0, 2)).toEqual(["switch-client", "-t"]);
});
