import { test, expect, spyOn } from "bun:test";
import { buildAttachCommands, decideAttach } from "../src/attach.ts";
import type { SessionRow } from "@agmux/protocol";
import { fakeRex } from "./helpers/fake-rex.ts";
import type { PlacementOps } from "../src/mux-ops.ts";

const coords = { tmux_session: "agmux", tmux_window: "@4", tmux_pane: "%3", tmux_socket: null };

function sessionRow(over: Partial<SessionRow> = {}): SessionRow {
  return {
    tmux_server: null, mux: null, mux_label: null,
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

function remoteHub(row: SessionRow, calls: string[]) {
  return (async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${String(url)}`);
    const u = String(url);
    if (init?.method === "POST") return new Response(null, { status: 202 });
    if (u.includes("/sessions?")) return Response.json({ sessions: [{ session_id: row.session_id }] });
    if (u.endsWith("/hosts")) {
      return Response.json({ hosts: [{ host: "sbx-1", remote: "lab", transport: { kind: "openshell", gateway: "gw", target: "box1", bin: "openshell" } }] });
    }
    return Response.json({ session: row, usage: null });
  }) as unknown as typeof fetch;
}

test("attachCmd on a live remote row outside tmux runs the pane process in full mode, in the foreground", async () => {
  const { attachCmd } = await import("../src/attach.ts");
  const { DEFAULT_ATTACH_SETTINGS } = await import("../src/attach-place.ts");
  const row = sessionRow({ remote: true, remote_tmux: { session: "work", window: "@0", pane: "%0", socket: null }, host: "sbx-1", status: "idle", pid: null, tmux_session: null, tmux_window: null, tmux_pane: null });
  const calls: string[] = [];
  const origFetch = globalThis.fetch;
  const origTmux = process.env.TMUX;
  delete process.env.TMUX;
  globalThis.fetch = remoteHub(row, calls);
  const spawn = spyOn(Bun, "spawn").mockImplementation((() => ({ exited: Promise.resolve(0), exitCode: 0 })) as never);
  try {
    expect(await attachCmd({ idOrPrefix: "019f", hubUrl: "http://hub", wrapBin: "agmux-wrap", settings: { ...DEFAULT_ATTACH_SETTINGS, agmuxBin: "/bin/agmux" } })).toBe(0);
    expect(spawn).toHaveBeenCalledTimes(1);
    const [argv, o] = spawn.mock.calls[0] as unknown as [string[], { stdio: string[] }];
    expect(argv).toEqual(["/bin/agmux", "attach", row.session_id, "--remote-client", "--mode", "full", "--detach-key", "M-d"]);
    expect(o.stdio).toEqual(["inherit", "inherit", "inherit"]);
    expect(calls.some((c) => c.startsWith("POST") && c.includes("/ingest"))).toBe(true);
  } finally {
    globalThis.fetch = origFetch; spawn.mockRestore();
    if (origTmux === undefined) delete process.env.TMUX; else process.env.TMUX = origTmux;
  }
});

test("attachCmd on a closed remote row resumes it in the sandbox, then runs the pane process", async () => {
  const { attachCmd } = await import("../src/attach.ts");
  const { DEFAULT_ATTACH_SETTINGS } = await import("../src/attach-place.ts");
  const row = sessionRow({ remote: true, host: "sbx-1", status: "lost", pid: null });
  const printed = { session: "agmux", window: "@1", pane: "%4", socket: null, server: null };
  const resumed = { ...row, status: "idle" as const, remote_tmux: printed };
  const calls: string[] = [];
  const execs: string[][] = [];
  const origFetch = globalThis.fetch;
  const origTmux = process.env.TMUX;
  delete process.env.TMUX;
  const hub = remoteHub(row, calls);
  globalThis.fetch = (async (url: string, init?: RequestInit) => String(url).includes("&host=")
    ? Response.json({ sessions: [resumed] })
    : hub(url, init)) as unknown as typeof fetch;
  const spawn = spyOn(Bun, "spawn").mockImplementation((() => ({ exited: Promise.resolve(0), exitCode: 0 })) as never);
  try {
    expect(await attachCmd({
      idOrPrefix: "019f", hubUrl: "http://hub", wrapBin: "agmux-wrap", remotes: () => [],
      settings: { ...DEFAULT_ATTACH_SETTINGS, agmuxBin: "/bin/agmux" },
      resumeRemote: {
        control: { status: async () => ({ state: "ready" }), start: async () => {} },
        exec: async (argv) => { execs.push(argv); return { code: 0, stdout: JSON.stringify({ remote_tmux: printed }), stderr: "" }; },
      },
    })).toBe(0);
    expect(execs).toEqual([["openshell", "-g", "gw", "sandbox", "exec", "-n", "box1", "--no-tty", "--",
      "agmux", "attach", row.session_id, "--resume-nearest", "--print-coords"]]);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0]![0]).toEqual(["/bin/agmux", "attach", row.session_id, "--remote-client", "--mode", "full", "--detach-key", "M-d"]);
    expect(calls.some((c) => c.startsWith("POST") && c.includes("/ingest"))).toBe(true);
  } finally {
    globalThis.fetch = origFetch; spawn.mockRestore();
    if (origTmux === undefined) delete process.env.TMUX; else process.env.TMUX = origTmux;
  }
});

test("attachCmd on a closed remote row whose sandbox is gone exits 2 with the message, never spawns", async () => {
  const { attachCmd } = await import("../src/attach.ts");
  const row = sessionRow({ remote: true, host: "sbx-gone", status: "lost", pid: null });
  const origFetch = globalThis.fetch;
  globalThis.fetch = remoteHub(row, []);
  const spawn = spyOn(Bun, "spawn").mockImplementation((() => { throw new Error("spawn"); }) as never);
  const err = spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(await attachCmd({ idOrPrefix: "019f", hubUrl: "http://hub", wrapBin: "agmux-wrap", remotes: () => [] })).toBe(2);
    expect(err).toHaveBeenCalledWith("resume: sandbox sbx-gone is gone; cannot resume");
    expect(spawn).not.toHaveBeenCalled();
  } finally {
    globalThis.fetch = origFetch; spawn.mockRestore(); err.mockRestore();
  }
});

test("attachCmd on a local row never reads attach settings (a broken config cannot fail it)", async () => {
  const { attachCmd } = await import("../src/attach.ts");
  const row = sessionRow({ status: "lost" });
  const origFetch = globalThis.fetch;
  const origTmux = process.env.TMUX;
  delete process.env.TMUX;
  globalThis.fetch = remoteHub(row, []);
  const spawn = spyOn(Bun, "spawn").mockImplementation((() => ({ exited: Promise.resolve(0), exitCode: 0 })) as never);
  let loaded = 0;
  try {
    const code = await attachCmd({
      idOrPrefix: "019f", hubUrl: "http://hub", wrapBin: "agmux-wrap",
      loadSettings: () => { loaded++; throw new Error("config.toml: bad"); },
    });
    expect(code).toBe(0);
    expect(loaded).toBe(0);
    expect((spawn.mock.calls[0] as unknown as [string[]])[0][0]).toBe("agmux-wrap"); // resumed locally
  } finally {
    globalThis.fetch = origFetch; spawn.mockRestore();
    if (origTmux === undefined) delete process.env.TMUX; else process.env.TMUX = origTmux;
  }
});

test("attachCmd on a remote row with a broken config warns and uses the attach defaults", async () => {
  const { attachCmd } = await import("../src/attach.ts");
  const row = sessionRow({ remote: true, remote_tmux: { session: "work", window: "@0", pane: "%0", socket: null }, host: "sbx-1", status: "idle", pid: null, tmux_session: null, tmux_window: null, tmux_pane: null });
  const origFetch = globalThis.fetch;
  const origTmux = process.env.TMUX;
  delete process.env.TMUX;
  globalThis.fetch = remoteHub(row, []);
  const spawn = spyOn(Bun, "spawn").mockImplementation((() => ({ exited: Promise.resolve(0), exitCode: 0 })) as never);
  const err = spyOn(console, "error").mockImplementation(() => {});
  try {
    const code = await attachCmd({
      idOrPrefix: "019f", hubUrl: "http://hub", wrapBin: "agmux-wrap",
      loadSettings: () => { throw new Error("config.toml: bad"); },
    });
    expect(code).toBe(0);
    expect(err).toHaveBeenCalledWith("agmux: config ignored, using attach defaults: config.toml: bad");
    expect((spawn.mock.calls[0] as unknown as [string[]])[0]).toEqual(
      ["agmux", "attach", row.session_id, "--remote-client", "--mode", "full", "--detach-key", "M-d"]);
  } finally {
    globalThis.fetch = origFetch; spawn.mockRestore(); err.mockRestore();
    if (origTmux === undefined) delete process.env.TMUX; else process.env.TMUX = origTmux;
  }
});

// attachCmd across Rex and tmux (spec §5.2, §5.3).
const RS = "session:01a1-row";
const RB = "block:01a1-row";
const RSERVER = "unix:///row";
const rexRow = (over: Partial<SessionRow> = {}) => sessionRow({
  mux: "rex", mux_label: "work", tmux_session: RS, tmux_window: "window:01a1-row", tmux_pane: RB, tmux_socket: RSERVER, ...over,
});
const presence = (code: number) => ({ [`block inspect ${RB} -s ${RS} --json`]: { code } });
const focusable = {
  ...presence(0),
  [`api call -s ${RS} session.focus_block ${JSON.stringify({ session_id: RS, block_id: RB })}`]: { stdout: "{}" },
  "client ls --json": { stdout: JSON.stringify({ clients: [{ client_id: "client:app", info: { kind: "app" } }] }) },
  [`-C client:app do session.select session_id=${RS} window_id=window:01a1-row`]: {},
};

function opsSpy(here: { session: string; window: string; pane: string; socket: string | null } | null, kind: "tmux" | "rex" = "tmux") {
  const calls: { newWindow: any[]; newSession: any[]; switched: string[] } = { newWindow: [], newSession: [], switched: [] };
  const ops: PlacementOps = {
    kind, currentPane: async () => here,
    splitPane: async () => { throw new Error("split"); },
    hasSession: async () => here !== null,
    newWindow: async (a: any) => { calls.newWindow.push(a); return { session: a.sessionName, window: "@7", pane: "%7", socket: a.socket ?? null }; },
    newSession: async (a: any) => { calls.newSession.push(a); return { session: a.sessionName, window: "@1", pane: "%1", socket: a.socket ?? null }; },
    switchClient: async (t: string) => { calls.switched.push(t); },
  };
  return { calls, ops };
}

async function runAttach(row: SessionRow, env: Record<string, string>, extra: object) {
  const { attachCmd } = await import("../src/attach.ts");
  const keys = ["TMUX", "REX_BLOCK", "REX_SESSION", "REX_SERVER"];
  const orig = keys.map((k) => process.env[k]);
  for (const k of keys) delete process.env[k];
  Object.assign(process.env, env);
  const origFetch = globalThis.fetch;
  globalThis.fetch = remoteHub(row, []);
  const spawn = spyOn(Bun, "spawn").mockImplementation((() => ({ exited: Promise.resolve(0), exitCode: 0 })) as never);
  const err = spyOn(console, "error").mockImplementation(() => {});
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    const code = await attachCmd({
      idOrPrefix: "019f", hubUrl: "http://hub", wrapBin: "agmux-wrap",
      sessionExists: async () => { throw new Error("tmux probed"); }, ...extra,
    });
    return {
      code, spawnArgv: spawn.mock.calls.map((c) => (c as unknown as [string[]])[0]),
      spawnEnv: spawn.mock.calls.map((c) => (c as unknown as [string[], { env: Record<string, string> }])[1].env),
      errs: err.mock.calls.map((c) => String(c[0])), logs: log.mock.calls.map((c) => String(c[0])),
    };
  } finally {
    globalThis.fetch = origFetch; spawn.mockRestore(); err.mockRestore(); log.mockRestore();
    keys.forEach((k, i) => { if (orig[i] === undefined) delete process.env[k]; else process.env[k] = orig[i]; });
  }
}

test("agmux attach outside Rex prints 'opened in Rex' and exits 0", async () => {
  const r = await runAttach(rexRow(), {}, { rexExec: fakeRex(focusable) });
  expect(r.code).toBe(0);
  expect(r.logs).toEqual(["opened in Rex"]);
  expect(r.spawnArgv).toEqual([]);
});

test("attach of an unreachable Rex row does not resume and reports it", async () => {
  const envs: Record<string, string>[] = [{}, { TMUX: "/s,1,0" }, { REX_BLOCK: "block:me", REX_SESSION: "session:me", REX_SERVER: RSERVER }];
  for (const env of envs) {
    const r = await runAttach(rexRow(), env, { rexExec: fakeRex(presence(4)), ops: opsSpy(null).ops });
    expect(r.code).toBe(2);
    expect(r.errs).toEqual(["Rex server unreachable; not resuming 019f1898"]);
    expect(r.spawnArgv).toEqual([]);
  }
});

test("attach of a Rex row with no app reports it and does not resume", async () => {
  const exec = fakeRex({ ...focusable, "client ls --json": { stdout: JSON.stringify({ clients: [] }) } });
  const r = await runAttach(rexRow(), {}, { rexExec: exec });
  expect(r.code).toBe(2);
  expect(r.errs).toEqual(["Rex app not running"]);
  expect(r.spawnArgv).toEqual([]);
});

test("attach of a live Rex row in Rex focuses it silently", async () => {
  const exec = fakeRex({ ...focusable, "block inspect block:me --json": { stdout: JSON.stringify({ block: { owner: "client:app" } }) } });
  const { ops } = opsSpy({ session: "session:me", window: "window:me", pane: "block:me", socket: RSERVER }, "rex");
  const r = await runAttach(rexRow(), { REX_BLOCK: "block:me" }, { rexExec: exec, ops });
  expect(r.code).toBe(0);
  expect(r.logs).toEqual([]);
  expect(exec.calls.flat()).toContain("session.select");
});

test("attach of a live tmux row in Rex opens a tmux tab in the caller's session", async () => {
  const exec = fakeRex({
    "block ls -s session:me --json": { stdout: JSON.stringify({ blocks: [] }) },
  });
  const calls: string[][] = [];
  const rexExec = (async (a: string[]) => {
    calls.push(a);
    return a.includes("run") ? { code: 0, stdout: JSON.stringify({ window_id: "window:t", block_ids: ["block:t"] }) } : exec(a);
  }) as typeof exec;
  const { ops } = opsSpy({ session: "session:me", window: "window:me", pane: "block:me", socket: RSERVER }, "rex");
  const r = await runAttach(sessionRow({ tmux_session: "work", tmux_window: "@1" }), { REX_BLOCK: "block:me" }, {
    rexExec, sessionExists: async () => true, ops,
  });
  expect(r.code).toBe(0);
  expect(r.errs).toEqual([]);
  expect(r.spawnArgv).toEqual([]);
  expect(calls.some((c) => c.includes("run") && c.includes("session:me"))).toBe(true);
});

test("resume of a closed Rex row from tmux targets the caller's tmux session, never the row's UUID", async () => {
  const { calls, ops } = opsSpy({ session: "caller", window: "@1", pane: "%1", socket: "/sock" });
  const r = await runAttach(rexRow({ status: "lost" }), { TMUX: "/s,1,0" }, { rexExec: fakeRex({}), ops });
  expect(r.code).toBe(0);
  expect(calls.newWindow.map((a) => [a.sessionName, a.socket])).toEqual([["caller", "/sock"]]);
  expect(JSON.stringify(calls)).not.toContain("01a1-row");
});

test("resume of a closed Rex row from tmux with no readable pane uses the default session", async () => {
  const { calls, ops } = opsSpy(null);
  await runAttach(rexRow({ status: "lost" }), { TMUX: "/s,1,0" }, { rexExec: fakeRex({}), ops });
  expect(calls.newSession[0].sessionName).toBe("agmux");
});

test("a closed tmux row from tmux with no readable pane keeps its session name", async () => {
  const { calls, ops } = opsSpy(null);
  await runAttach(sessionRow({ status: "lost", tmux_session: "work" }), { TMUX: "/s,1,0" }, { ops });
  expect(calls.newSession[0].sessionName).toBe("work");
});

test("resume of a closed Rex row outside any mux does not pass the UUID to tmux", async () => {
  const r = await runAttach(rexRow({ status: "lost" }), {}, { rexExec: fakeRex({}) });
  expect(r.code).toBe(0);
  expect(r.spawnArgv[0]![0]).toBe("agmux-wrap");
  expect(JSON.stringify([r.spawnArgv, r.spawnEnv])).not.toContain("01a1-row");
});

test("resume of a closed tmux row inside Rex opens a new tab and never calls tmux", async () => {
  const { calls, ops } = opsSpy({ session: "session:me", window: "window:me", pane: "block:me", socket: RSERVER }, "rex");
  const r = await runAttach(sessionRow({ status: "lost", tmux_session: "work" }), { REX_BLOCK: "block:me" }, { ops });
  expect(r.code).toBe(0);
  expect(calls.newWindow.map((a) => a.sessionName)).toEqual(["session:me"]);
  expect(calls.switched).toEqual(["session:me:@7"]);
  expect(r.spawnArgv).toEqual([]);
});
