import { test, expect } from "bun:test";
import type { SessionRow } from "@agmux/protocol";
import type { Actions, AttachRequest } from "@agmux/tui";
import { attachPlacedCmd } from "../src/attach-placed.ts";
import { DEFAULT_ATTACH_SETTINGS } from "../src/attach-place.ts";

const ID = "019f1898-8e0f-7000-ab55-07d09f673b59";
function row(over: Partial<SessionRow> = {}): SessionRow {
  return {
    session_id: ID, agent_kind: "claude", profile: null, native_session_id: null,
    command: "claude", args: [], env_overrides: {}, cwd: "/tmp", pid: 1,
    tmux_session: "work", tmux_window: "@3", tmux_pane: "%5", tmux_socket: null,
    host: "h", project: null, parent_session_id: null,
    start_ts: "2026-10-09T10:00:00.000Z", last_heartbeat_ts: null,
    end_ts: null, exit_code: null, signal: null, status: "running", origin: "native", ...over,
  };
}

async function withHub<T>(session: SessionRow, fn: () => Promise<T>): Promise<T> {
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (init?.method === "POST") return new Response(null, { status: 202 });
    if (u.includes("/sessions?")) return new Response(JSON.stringify({ sessions: [session] }));
    return new Response(JSON.stringify({ session, usage: null }));
  }) as unknown as typeof fetch;
  try { return await fn(); } finally { globalThis.fetch = orig; }
}

function fakeActions(log: string[]): Actions {
  return {
    async attach(_r, req?: AttachRequest) { log.push(`attach:${req?.placement}`); return { argv: ["tmux", "attach"] }; },
    async resume(_r, req?: AttachRequest) { log.push(`resume:${req?.placement}`); return null; },
    async kill() {}, async copy() {}, async markSeen() {},
  };
}

test("a live session is attached with the requested placement and the handoff runs", async () => {
  const log: string[] = [];
  const ran: string[][] = [];
  const code = await withHub(row(), () => attachPlacedCmd(
    { idOrPrefix: "019f", hubUrl: "http://hub", wrapBin: "w", placement: "inline", settings: DEFAULT_ATTACH_SETTINGS },
    { makeActionsImpl: () => fakeActions(log), spawn: async (h) => { ran.push(h.argv); return 0; } },
  ));
  expect(code).toBe(0);
  expect(log).toEqual(["attach:inline"]);
  expect(ran).toEqual([["tmux", "attach"]]);
});

test("a closed session is resumed with the requested placement", async () => {
  const log: string[] = [];
  const code = await withHub(row({ status: "lost" }), () => attachPlacedCmd(
    { idOrPrefix: "019f", hubUrl: "http://hub", wrapBin: "w", placement: "new-window", settings: DEFAULT_ATTACH_SETTINGS },
    { makeActionsImpl: () => fakeActions(log), spawn: async () => 0 },
  ));
  expect(code).toBe(0);
  expect(log).toEqual(["resume:new-window"]);
});

test("an unavailable placement prints its reason and exits 2", async () => {
  const errs: string[] = [];
  const throwing: Actions = { ...fakeActions([]), async attach() { throw new Error("new pane: not in tmux"); } };
  const code = await withHub(row(), () => attachPlacedCmd(
    { idOrPrefix: "019f", hubUrl: "http://hub", wrapBin: "w", placement: "new-pane", settings: DEFAULT_ATTACH_SETTINGS },
    { makeActionsImpl: () => throwing, spawn: async () => 0, err: (s) => errs.push(s) },
  ));
  expect(code).toBe(2);
  expect(errs).toEqual(["attach: new pane: not in tmux"]);
});

test("a live session without tmux coords is an error", async () => {
  const errs: string[] = [];
  const code = await withHub(row({ tmux_session: null, tmux_window: null }), () => attachPlacedCmd(
    { idOrPrefix: "019f", hubUrl: "http://hub", wrapBin: "w", placement: "inline", settings: DEFAULT_ATTACH_SETTINGS },
    { makeActionsImpl: () => fakeActions([]), spawn: async () => 0, err: (s) => errs.push(s) },
  ));
  expect(code).toBe(1);
  expect(errs).toEqual(["attach: session has no tmux pane"]);
});
