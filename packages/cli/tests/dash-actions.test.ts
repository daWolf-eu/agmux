import { test, expect } from "bun:test";
import { attachInPopup, resumeIntoSession, makeActions, type ResumePlacementDeps, type ActionDeps } from "../src/dash-actions.ts";
import { attachSettingsFrom } from "../src/attach-place.ts";
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

test("makeActions exposes a copy() method", () => {
  const actions = makeActions("http://localhost:0", "agmux", false);
  expect(typeof actions.copy).toBe("function");
});

const SOCK = "/private/tmp/tmux-501/default";
const TMUX_ENV = `${SOCK},123,0`;
const CALLER = { session: "caller", window: "@1", pane: "%9", socket: SOCK };
const SETTINGS = attachSettingsFrom({ terminal: { newWindow: ["term", "-e", "{cmd}"] } }, "/bin/agmux");
const liveRow = (over: Partial<SessionRow> = {}) =>
  staleRow({ tmux_session: "work", tmux_window: "@3", tmux_pane: "%5", tmux_socket: SOCK, ...over });

async function withTmux<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const orig = process.env.TMUX;
  if (value === undefined) delete process.env.TMUX; else process.env.TMUX = value;
  try { return await fn(); } finally { if (orig === undefined) delete process.env.TMUX; else process.env.TMUX = orig; }
}

async function withSession<T>(session: SessionRow, fn: () => Promise<T>): Promise<T> {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ session, usage: { turn_count: 5 } }))) as unknown as typeof fetch;
  try { return await fn(); } finally { globalThis.fetch = orig; }
}

function recorder(over: Partial<ActionDeps> = {}) {
  const tmux: string[][] = [];
  const spawned: string[][] = [];
  const deps: ActionDeps = {
    runTmux: async (a) => { tmux.push(a); },
    sessionExists: async () => true,
    currentPane: async () => CALLER,
    spawnDetached: (argv) => { spawned.push(argv); },
    windowInSession: async (session) => session === "work",
    now: () => 0,
    ...over,
  };
  return { tmux, spawned, deps };
}

test("live new-window: a view client in a new window of the caller's session", async () => {
  const r = recorder();
  const h = await withTmux(TMUX_ENV, () =>
    makeActions("http://hub", "agmux-wrap", false, r.deps, SETTINGS).attach(liveRow(), { placement: "new-window" }));
  expect(h).toBeNull();
  expect(r.tmux).toHaveLength(1);
  const cmd = r.tmux[0]!;
  // held on failure, so a view that can't start shows why instead of flickering
  expect(cmd.slice(0, 9)).toEqual(["-S", SOCK, "new-window", "-t", "caller:", "-n", "view:019f1898", "--", "/bin/sh"]);
  expect(cmd.slice(12, 13)).toEqual(["env"]);
  expect(cmd).toContain("agmux-view-019f1898-0");
  // the outer tmux must not split the view command at its separators
  expect(cmd).not.toContain(";");
  expect(cmd).toContain("\\;");
});

test("live new-pane: splits the caller's pane with a view client", async () => {
  const r = recorder();
  await withTmux(TMUX_ENV, () =>
    makeActions("http://hub", "agmux-wrap", false, r.deps, SETTINGS).attach(liveRow(), { placement: "new-pane" }));
  expect(r.tmux[0]!.slice(0, 7)).toEqual(["-S", SOCK, "split-window", "-t", "%9", "--", "/bin/sh"]);
});

test("live new-window when the agent is in the caller's own session falls back to inline", async () => {
  const r = recorder({ currentPane: async () => ({ ...CALLER, session: "work" }) });
  await withTmux(TMUX_ENV, () =>
    makeActions("http://hub", "agmux-wrap", false, r.deps, SETTINGS).attach(liveRow(), { placement: "new-window" }));
  expect(r.tmux).toEqual([
    ["-S", SOCK, "switch-client", "-t", "work:@3"],
    ["-S", SOCK, "select-pane", "-t", "%5"],
  ]);
});

test("live new-session: grouped session, switched to", async () => {
  const r = recorder({ sessionExists: async (name) => name === "work" });
  await withTmux(TMUX_ENV, () =>
    makeActions("http://hub", "agmux-wrap", false, r.deps, SETTINGS).attach(liveRow(), { placement: "new-session" }));
  expect(r.tmux.map((c) => c[2])).toEqual(["new-session", "switch-client", "set-option", "select-window", "select-pane"]);
});

test("new-terminal spawns the template with `agmux attach <id>`; popup closes", async () => {
  const r = recorder();
  const h = await withTmux(TMUX_ENV, () =>
    makeActions("http://hub", "agmux-wrap", true, r.deps, SETTINGS).attach(liveRow(), { placement: "new-terminal" }));
  expect(r.spawned).toEqual([["term", "-e", "/bin/agmux", "attach", "019f1898-8e0f-7000-ab55-07d09f673b59"]]);
  expect(h).toEqual({ argv: [] });
});

test("an unavailable placement is rejected with its reason", async () => {
  const r = recorder();
  await expect(withTmux(undefined, () =>
    makeActions("http://hub", "agmux-wrap", false, r.deps, SETTINGS).attach(liveRow(), { placement: "new-pane" })))
    .rejects.toThrow("new pane: not in tmux");
});

test("closed inline in tmux hands the dash's pane to the resumed agent", async () => {
  const r = recorder();
  const row = staleRow({ status: "lost" });
  const h = await withTmux(TMUX_ENV, () => withSession(row, () =>
    makeActions("http://hub", "agmux-wrap", false, r.deps, SETTINGS).resume(row, { placement: "inline" })));
  expect(h!.argv[0]).toBe("agmux-wrap");
  expect(r.tmux).toEqual([]);
});

test("closed new-pane splits the caller's pane with the resumed agent", async () => {
  const splits: unknown[] = [];
  const r = recorder({ splitPane: (async (a: unknown) => { splits.push(a); return { session: "caller", window: "@1", pane: "%10", socket: SOCK }; }) as ActionDeps["splitPane"] });
  const row = staleRow({ status: "lost" });
  const h = await withTmux(TMUX_ENV, () => withSession(row, () =>
    makeActions("http://hub", "agmux-wrap", false, r.deps, SETTINGS).resume(row, { placement: "new-pane" })));
  expect(h).toBeNull();
  expect(splits).toHaveLength(1);
  expect((splits[0] as { targetPane: string; cmd: string[] }).targetPane).toBe("%9");
  expect((splits[0] as { cmd: string[] }).cmd[0]).toBe("agmux-wrap");
});

test("stale-live row with a placement resumes, validated as a closed session", async () => {
  const r = recorder({ sessionExists: async () => false });
  const row = liveRow({ status: "idle" });
  // inline is fine for a closed row outside a popup → resume handoff
  const h = await withTmux(TMUX_ENV, () => withSession(row, () =>
    makeActions("http://hub", "agmux-wrap", false, r.deps, SETTINGS).attach(row, { placement: "inline" })));
  expect(h!.argv[0]).toBe("agmux-wrap");
  // peek is never available for a closed session
  await expect(withTmux(TMUX_ENV, () => withSession(row, () =>
    makeActions("http://hub", "agmux-wrap", false, r.deps, SETTINGS).attach(row, { placement: "peek" }))))
    .rejects.toThrow("peek: ends with popup");
});

test("closed row in a popup without a request still resumes into a new window", async () => {
  const placed: string[] = [];
  const r = recorder({
    placement: {
      hasSession: async () => true,
      newWindow: (async () => { placed.push("newWindow"); return { session: "caller", window: "@7", pane: "%11", socket: SOCK }; }) as never,
      newSession: (async () => { throw new Error("no"); }) as never,
      switchClient: async () => {},
    },
  });
  const row = staleRow({ status: "lost" });
  const h = await withTmux(TMUX_ENV, () => withSession(row, () =>
    makeActions("http://hub", "agmux-wrap", true, r.deps, SETTINGS).resume(row)));
  expect(placed).toEqual(["newWindow"]);
  expect(h).toEqual({ argv: [] });
});

test("live new-window for a socket-less row in the caller's session falls back to inline", async () => {
  // agmux run from a plain shell records tmux_socket null (the default server)
  const r = recorder({ currentPane: async () => ({ ...CALLER, session: "work" }) });
  await withTmux(TMUX_ENV, () =>
    makeActions("http://hub", "agmux-wrap", false, r.deps, SETTINGS).attach(liveRow({ tmux_socket: null }), { placement: "new-window" }));
  expect(r.tmux).toEqual([
    ["switch-client", "-t", "work:@3"],
    ["select-pane", "-t", "%5"],
  ]);
});

test("live new-pane from a session grouped with the agent's falls back to inline", async () => {
  // e.g. the dash runs inside the agmux-<id8> session created by "new session"
  const r = recorder({
    currentPane: async () => ({ ...CALLER, session: "agmux-019f1898" }),
    windowInSession: async (session, window) => session === "agmux-019f1898" && window === "@3",
  });
  await withTmux(TMUX_ENV, () =>
    makeActions("http://hub", "agmux-wrap", false, r.deps, SETTINGS).attach(liveRow(), { placement: "new-pane" }));
  expect(r.tmux.map((c) => c[2])).toEqual(["switch-client", "select-pane"]);
});

test("live new-session for an agent on another tmux server is refused before touching tmux", async () => {
  const r = recorder();
  await expect(withTmux(TMUX_ENV, () =>
    makeActions("http://hub", "agmux-wrap", false, r.deps, SETTINGS).attach(liveRow({ tmux_socket: "/tmp/other-server" }), { placement: "new-session" })))
    .rejects.toThrow("new session: agent is on another tmux server");
  expect(r.tmux).toEqual([]);
});

test("terminal templates are launched without the dash's tmux env", async () => {
  const envs: Record<string, string | undefined>[] = [];
  const r = recorder({ spawnDetached: (_argv, env) => { envs.push(env); } });
  const origPane = process.env.TMUX_PANE;
  process.env.TMUX_PANE = "%9";
  try {
    await withTmux(TMUX_ENV, () =>
      makeActions("http://hub", "agmux-wrap", false, r.deps, SETTINGS).attach(liveRow(), { placement: "new-terminal" }));
  } finally {
    if (origPane === undefined) delete process.env.TMUX_PANE; else process.env.TMUX_PANE = origPane;
  }
  expect(envs).toHaveLength(1);
  expect("TMUX" in envs[0]!).toBe(false);
  expect("TMUX_PANE" in envs[0]!).toBe(false);
  expect(envs[0]!.PATH).toBe(process.env.PATH);
});
