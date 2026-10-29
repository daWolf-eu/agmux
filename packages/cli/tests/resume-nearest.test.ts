import { test, expect } from "bun:test";
import { parsePrintedCoords, type LaunchSpec, type SessionRow } from "@agmux/protocol";
import { createDefaultRegistry } from "@agmux/adapters";
import {
  pickNearest, resumeNearestCmd, parseResumeNearestArgs,
  type NearestDeps, type ResumeNearestDeps,
} from "../src/resume-nearest.ts";

const ID = "019f1898-8e0f-7000-ab55-07d09f673b59";
const N = "native-1";

function row(over: Partial<SessionRow> = {}): SessionRow {
  return {
    session_id: ID, agent_kind: "claude", profile: null, native_session_id: N,
    command: "claude", args: [], env_overrides: {}, cwd: "/sandbox/work", pid: null,
    tmux_session: "agmux", tmux_window: "@3", tmux_pane: "%5", tmux_socket: null, tmux_server: "100-200",
    host: "h", project: null, parent_session_id: null,
    start_ts: "t", last_heartbeat_ts: null, end_ts: "t", exit_code: 0, signal: null,
    status: "ended", origin: "native", ...over,
  };
}

interface World { server: string | null; windows: string[]; sessions: string[]; panes?: string[] }

function nearestDeps(w: World, calls: { fn: string; args: any }[] = []): NearestDeps {
  const coords = { session: "agmux", window: "@7", pane: "%9", socket: null };
  return {
    serverId: async () => w.server,
    windowExists: async (win) => w.windows.includes(win),
    hasSession: async (name) => w.sessions.includes(name),
    splitPane: async (a) => { calls.push({ fn: "splitPane", args: a }); return coords; },
    newWindow: async (a) => { calls.push({ fn: "newWindow", args: a }); return coords; },
    newSession: async (a) => { calls.push({ fn: "newSession", args: a }); return coords; },
  };
}

test("pickNearest: same server and window present → split in that window", async () => {
  const t = await pickNearest(row(), nearestDeps({ server: "100-200", windows: ["@3"], sessions: ["agmux"] }));
  expect(t).toEqual({ kind: "split", window: "@3" });
});

test("pickNearest: restarted server reusing @3 → new window, never split", async () => {
  const t = await pickNearest(row(), nearestDeps({ server: "777-888", windows: ["@3"], sessions: ["agmux"] }));
  expect(t).toEqual({ kind: "window", session: "agmux" });
});

test("pickNearest: unknown recorded server → never split", async () => {
  const t = await pickNearest(row({ tmux_server: null }), nearestDeps({ server: null, windows: ["@3"], sessions: ["agmux"] }));
  expect(t).toEqual({ kind: "window", session: "agmux" });
});

test("pickNearest: same server but window gone → new window in the session", async () => {
  const t = await pickNearest(row(), nearestDeps({ server: "100-200", windows: [], sessions: ["agmux"] }));
  expect(t).toEqual({ kind: "window", session: "agmux" });
});

test("pickNearest: session gone → new session with the old name", async () => {
  const t = await pickNearest(row({ tmux_session: "work" }), nearestDeps({ server: "777-888", windows: [], sessions: [] }));
  expect(t).toEqual({ kind: "session", name: "work" });
});

test("pickNearest: no recorded session → AGMUX_TMUX_SESSION, else agmux", async () => {
  const r = row({ tmux_session: null, tmux_window: null, tmux_server: null });
  const none = nearestDeps({ server: null, windows: [], sessions: [] });
  expect(await pickNearest(r, none, { AGMUX_TMUX_SESSION: "mine" })).toEqual({ kind: "session", name: "mine" });
  expect(await pickNearest(r, none, {})).toEqual({ kind: "session", name: "agmux" });
  const hasDefault = nearestDeps({ server: null, windows: [], sessions: ["agmux"] });
  expect(await pickNearest(r, hasDefault, {})).toEqual({ kind: "window", session: "agmux" });
});

function fakeFetch(rows: SessionRow[], usage: { turn_count: number } | null = { turn_count: 3 }): typeof fetch {
  return (async (url: string) => {
    const u = String(url);
    if (u.includes("/sessions?")) return Response.json({ sessions: rows });
    const id = u.split("/sessions/")[1]!;
    return Response.json({ session: rows.find((r) => r.session_id === id), usage });
  }) as unknown as typeof fetch;
}

function cmdDeps(rows: SessionRow[], w: World, over: Partial<ResumeNearestDeps> = {}) {
  const calls: { fn: string; args: any }[] = [];
  const err: string[] = [];
  const deps: ResumeNearestDeps = {
    ...nearestDeps(w, calls),
    fetchImpl: fakeFetch(rows),
    paneExists: async (pane) => (w.panes ?? []).includes(pane),
    paneServerId: async () => "777-888",
    registry: createDefaultRegistry(),
    loadProfileLaunch: (name) => name === "p" ? { command: "claude", args: ["--model", "x"], env: { P: "1" } } : undefined,
    err: (l) => err.push(l),
    ...over,
  };
  return { deps, calls, err };
}

const skipPerms: LaunchSpec = { profile: null, command: "claude", args: ["--dangerously-skip-permissions"] };

function opts(out: string[], fallbackLaunch: LaunchSpec | null = null) {
  return { idOrPrefix: ID.slice(0, 8), hubUrl: "http://hub", agmuxBin: "/usr/bin/agmux", fallbackLaunch, out: (l: string) => out.push(l) };
}

test("resumeNearestCmd: hand-started native row resumes with the fallback args, detached, prints one parsable line", async () => {
  const out: string[] = [];
  const f = cmdDeps([row()], { server: "777-888", windows: ["@3"], sessions: ["agmux"] });
  expect(await resumeNearestCmd(opts(out, skipPerms), f.deps)).toBe(0);
  expect(f.calls.map((c) => c.fn)).toEqual(["newWindow"]);
  const a = f.calls[0]!.args;
  expect(a.cmd).toEqual(["claude", "--resume", N, "--dangerously-skip-permissions"]);
  expect(a.detach).toBe(true);
  expect(a.sessionName).toBe("agmux");
  expect(a.windowName).toBe(`agmux:${ID.slice(0, 8)}`);
  expect(a.cwd).toBe("/sandbox/work");
  expect(a.env.AGMUX_SESSION_ID).toBeUndefined();
  expect(a.env.AGMUX_HUB_URL).toBe("http://hub");
  expect(a.env.AGMUX_BIN).toBe("/usr/bin/agmux");
  expect(JSON.parse(a.env.AGMUX_LAUNCH)).toEqual(skipPerms);
  expect(a.env.AGMUX_PROFILE).toBeUndefined();
  expect(out).toHaveLength(1);
  expect(parsePrintedCoords(out[0]!)).toEqual({ session: "agmux", window: "@7", pane: "%9", socket: null, server: "777-888" });
});

test("resumeNearestCmd: same server and window → detached split in the old window", async () => {
  const out: string[] = [];
  const f = cmdDeps([row()], { server: "100-200", windows: ["@3"], sessions: ["agmux"] });
  expect(await resumeNearestCmd(opts(out), f.deps)).toBe(0);
  expect(f.calls.map((c) => c.fn)).toEqual(["splitPane"]);
  expect(f.calls[0]!.args.targetPane).toBe("@3");
  expect(f.calls[0]!.args.detach).toBe(true);
});

test("resumeNearestCmd: recorded profile launch sets AGMUX_PROFILE and keeps the profile args", async () => {
  const out: string[] = [];
  const f = cmdDeps([row({ profile: "p", tmux_session: "work" })], { server: null, windows: [], sessions: [] });
  expect(await resumeNearestCmd(opts(out, skipPerms), f.deps)).toBe(0);
  expect(f.calls.map((c) => c.fn)).toEqual(["newSession"]);
  const a = f.calls[0]!.args;
  expect(a.sessionName).toBe("work");
  expect(a.cmd).toEqual(["claude", "--resume", N, "--model", "x"]);
  expect(a.env.AGMUX_PROFILE).toBe("p");
  expect(a.env.P).toBe("1");
});

test("resumeNearestCmd: remote row is refused with exit 2, nothing placed or printed", async () => {
  const out: string[] = [];
  const f = cmdDeps([row({ remote: true })], { server: null, windows: [], sessions: ["agmux"] });
  expect(await resumeNearestCmd(opts(out), f.deps)).toBe(2);
  expect(f.calls).toEqual([]);
  expect(out).toEqual([]);
  expect(f.err.join("\n")).toMatch(/remote/);
});

test("resumeNearestCmd: unknown id → exit 2", async () => {
  const out: string[] = [];
  const f = cmdDeps([row()], { server: null, windows: [], sessions: [] });
  expect(await resumeNearestCmd({ ...opts(out), idOrPrefix: "ffffffff" }, f.deps)).toBe(2);
  expect(out).toEqual([]);
});

const live = (over: Partial<SessionRow> = {}) => row({ status: "idle", end_ts: null, ...over });

test("resumeNearestCmd: live row, same server, pane present → prints its coords, places nothing", async () => {
  const out: string[] = [];
  const f = cmdDeps([live()], { server: "100-200", windows: ["@3"], sessions: ["agmux"], panes: ["%5"] });
  expect(await resumeNearestCmd(opts(out), f.deps)).toBe(0);
  expect(f.calls).toEqual([]);
  expect(out).toHaveLength(1);
  expect(parsePrintedCoords(out[0]!)).toEqual({ session: "agmux", window: "@3", pane: "%5", socket: null, server: "100-200" });
});

test("resumeNearestCmd: live row on a restarted server (recreated session, reused @3/%5) → relaunches in a new window", async () => {
  const out: string[] = [];
  const f = cmdDeps([live()], { server: "777-888", windows: ["@3"], sessions: ["agmux"], panes: ["%5"] });
  expect(await resumeNearestCmd(opts(out), f.deps)).toBe(0);
  expect(f.calls.map((c) => c.fn)).toEqual(["newWindow"]);
  expect(parsePrintedCoords(out[0]!)).toEqual({ session: "agmux", window: "@7", pane: "%9", socket: null, server: "777-888" });
});

test("resumeNearestCmd: live row, same server, pane gone → relaunches", async () => {
  const out: string[] = [];
  const f = cmdDeps([live()], { server: "100-200", windows: ["@3"], sessions: ["agmux"], panes: [] });
  expect(await resumeNearestCmd(opts(out), f.deps)).toBe(0);
  expect(f.calls.map((c) => c.fn)).toEqual(["splitPane"]);
});

test("resumeNearestCmd: live row without a recorded pane → relaunches, never prints unparsable coords", async () => {
  const out: string[] = [];
  const f = cmdDeps([live({ tmux_pane: null, tmux_server: null })], { server: "100-200", windows: ["@3"], sessions: ["agmux"], panes: ["%5"] });
  expect(await resumeNearestCmd(opts(out), f.deps)).toBe(0);
  expect(f.calls.map((c) => c.fn)).toEqual(["newWindow"]);
  expect(parsePrintedCoords(out[0]!)).not.toBeNull();
});

test("resumeNearestCmd: placement failure → exit 1, message on stderr, no stdout", async () => {
  const out: string[] = [];
  const f = cmdDeps([row()], { server: null, windows: [], sessions: [] }, {
    newSession: async () => { throw new Error("tmux exploded"); },
  });
  expect(await resumeNearestCmd(opts(out), f.deps)).toBe(1);
  expect(out).toEqual([]);
  expect(f.err.join("\n")).toMatch(/tmux exploded/);
});

test("parseResumeNearestArgs: requires --print-coords", () => {
  expect(parseResumeNearestArgs(["--resume-nearest"]).kind).toBe("error");
});

test("parseResumeNearestArgs: --fallback-launch is parsed; invalid JSON or unknown flags are errors", () => {
  const ok = parseResumeNearestArgs(["--resume-nearest", "--print-coords", "--fallback-launch", JSON.stringify(skipPerms)]);
  expect(ok).toEqual({ kind: "ok", fallbackLaunch: skipPerms });
  expect(parseResumeNearestArgs(["--print-coords", "--resume-nearest"])).toEqual({ kind: "ok", fallbackLaunch: null });
  expect(parseResumeNearestArgs(["--resume-nearest", "--print-coords", "--fallback-launch", "{nope"]).kind).toBe("error");
  expect(parseResumeNearestArgs(["--resume-nearest", "--print-coords", "--fallback-launch"]).kind).toBe("error");
  expect(parseResumeNearestArgs(["--resume-nearest", "--print-coords", "--mode", "view"]).kind).toBe("error");
});
