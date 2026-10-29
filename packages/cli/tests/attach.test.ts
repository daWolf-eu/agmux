import { test, expect, spyOn } from "bun:test";
import { buildAttachCommands, decideAttach } from "../src/attach.ts";
import type { SessionRow } from "@agmux/protocol";

const coords = { tmux_session: "agmux", tmux_window: "@4", tmux_pane: "%3", tmux_socket: null };

function sessionRow(over: Partial<SessionRow> = {}): SessionRow {
  return {
    tmux_server: null,
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

test("attachCmd on a closed remote row refuses the resume with the manual command, never spawns", async () => {
  const { attachCmd } = await import("../src/attach.ts");
  const row = sessionRow({ remote: true, host: "sbx-1", status: "lost", pid: null });
  const calls: string[] = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = remoteHub(row, calls);
  const spawn = spyOn(Bun, "spawn").mockImplementation((() => { throw new Error("spawn"); }) as never);
  const err = spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(await attachCmd({ idOrPrefix: "019f", hubUrl: "http://hub", wrapBin: "agmux-wrap", remotes: () => [] })).toBe(2);
    expect(err).toHaveBeenCalledWith(
      `resume: 019f1898 runs on sbx-1; remote resume is not supported yet; run it by hand: openshell -g gw sandbox exec -n box1 --tty -- agmux attach ${row.session_id}`);
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
