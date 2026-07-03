import { test, expect } from "bun:test";
import { attachInPopup, resumeIntoSession, makeActions, type ResumePlacementDeps } from "../src/dash-actions.ts";
import type { SessionRow } from "@agmux/protocol";

function staleRow(over: Partial<SessionRow> = {}): SessionRow {
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

test("makeActions.attach falls back to resume when the tmux session is gone", async () => {
  // A LIVE-status row whose tmux session no longer exists (pinned live by pid
  // reuse, spec §8) must resume, not run a doomed attach. Outside tmux, resume
  // returns a wrap-command handoff — distinguishable from attach's tmux handoff.
  const origFetch = globalThis.fetch;
  const origTmux = process.env.TMUX;
  delete process.env.TMUX;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ session: staleRow(), usage: { turn_count: 5 } }))) as unknown as typeof fetch;
  try {
    const actions = makeActions("http://hub", "agmux-wrap", false, {
      runTmux: async () => { throw new Error("attach must not run tmux for a gone session"); },
      sessionExists: async () => false,
    });
    const h = await actions.attach(staleRow());
    expect(h).not.toBeNull();
    expect(h!.argv[0]).toBe("agmux-wrap"); // resumed (wrap argv), did not attach (would be "tmux")
  } finally {
    globalThis.fetch = origFetch;
    if (origTmux === undefined) delete process.env.TMUX; else process.env.TMUX = origTmux;
  }
});

test("makeActions.attach is a no-op for a live row without tmux coords (no resume, no probe)", async () => {
  const actions = makeActions("http://hub", "agmux-wrap", false, {
    runTmux: async () => { throw new Error("should not run tmux"); },
    sessionExists: async () => { throw new Error("should not probe tmux"); },
  });
  const h = await actions.attach(staleRow({ tmux_window: null }));
  expect(h).toBeNull();
});

test("makeActions.attach attaches normally when the tmux session exists", async () => {
  const origTmux = process.env.TMUX;
  delete process.env.TMUX;
  try {
    const actions = makeActions("http://hub", "agmux-wrap", false, {
      runTmux: async () => {},
      sessionExists: async () => true,
    });
    const h = await actions.attach(staleRow());
    expect(h!.argv[0]).toBe("tmux"); // live + present → real attach handoff
  } finally {
    if (origTmux === undefined) delete process.env.TMUX; else process.env.TMUX = origTmux;
  }
});

test("attachInPopup issues switch-client (+ select-pane) then returns the exit sentinel", async () => {
  const calls: string[][] = [];
  const runTmux = async (args: string[]) => { calls.push(args); };
  const h = await attachInPopup(
    { tmux_session: "work", tmux_window: "@3", tmux_pane: "%5", tmux_socket: null },
    runTmux,
  );
  expect(calls).toEqual([
    ["switch-client", "-t", "work:@3"],
    ["select-pane", "-t", "%5"],
  ]);
  expect(h).toEqual({ argv: [] });
});

test("attachInPopup without a pane switches window only", async () => {
  const calls: string[][] = [];
  const runTmux = async (args: string[]) => { calls.push(args); };
  await attachInPopup({ tmux_session: "work", tmux_window: "@3", tmux_pane: null, tmux_socket: null }, runTmux);
  expect(calls).toEqual([["switch-client", "-t", "work:@3"]]);
});

function placementSpy(exists: boolean) {
  const calls: { newWindow: any[]; newSession: any[]; switched: Array<[string, string | null | undefined]> } = { newWindow: [], newSession: [], switched: [] };
  const deps: ResumePlacementDeps = {
    hasSession: async () => exists,
    newWindow: async (a: any) => { calls.newWindow.push(a); return { session: a.sessionName, window: "@7", pane: "%7", socket: a.socket ?? null }; },
    newSession: async (a: any) => { calls.newSession.push(a); return { session: a.sessionName, window: "@1", pane: "%1", socket: a.socket ?? null }; },
    switchClient: async (t: string, s?: string | null) => { calls.switched.push([t, s]); },
  };
  return { calls, deps };
}

const spec = {
  wrapArgv: ["agmux-wrap", "claude"],
  env: { PATH: "/bin", AGMUX_HUB_URL: "http://h", AGMUX_SESSION_ID: "abc12345" },
};

test("resumeIntoSession opens a new window in an existing session and switches the client", async () => {
  const { calls, deps } = placementSpy(true);
  const h = await resumeIntoSession(spec, "work", "abc12345", deps);
  expect(calls.newWindow).toHaveLength(1);
  expect(calls.newSession).toHaveLength(0);
  expect(calls.newWindow[0].sessionName).toBe("work");
  expect(calls.newWindow[0].windowName).toBe("agmux:abc12345");
  expect(calls.newWindow[0].cmd).toEqual(["agmux-wrap", "claude"]);
  // only the agmux env allowlist is forwarded (hub url + session id), PATH dropped
  expect(calls.newWindow[0].env).toEqual({ AGMUX_HUB_URL: "http://h", AGMUX_SESSION_ID: "abc12345" });
  expect(calls.newWindow[0].detach).toBe(true);
  expect(calls.switched).toEqual([["work:@7", null]]);
  expect(h).toEqual({ argv: [] });
});

test("resumeIntoSession threads the socket into newWindow and switchClient", async () => {
  const { calls, deps } = placementSpy(true);
  await resumeIntoSession(spec, "work", "abc12345", deps, "/sock");
  expect(calls.newWindow[0].socket).toBe("/sock");
  expect(calls.switched).toEqual([["work:@7", "/sock"]]);
});

test("resumeIntoSession creates the session when missing, then switches", async () => {
  const { calls, deps } = placementSpy(false);
  const h = await resumeIntoSession(spec, "gone", "abc12345", deps);
  expect(calls.newSession).toHaveLength(1);
  expect(calls.newWindow).toHaveLength(0);
  expect(calls.newSession[0].sessionName).toBe("gone");
  expect(calls.newSession[0].windowName).toBe("agmux:abc12345");
  expect(calls.switched).toEqual([["gone:@1", null]]);
  expect(h).toEqual({ argv: [] });
});
