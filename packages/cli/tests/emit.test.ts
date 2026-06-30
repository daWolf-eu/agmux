import { test, expect } from "bun:test";
import { parseEmitArgs, runEmit, enrichTmuxCoords } from "../src/emit.ts";
import { createRegistry, createDefaultRegistry } from "@agmux/adapters";
import { fakeAdapter } from "@agmux/adapters/testing";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

function reg() { const r = createRegistry(); r.register(fakeAdapter); return r; }
function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), "agmux-emit-")); }

test("parseEmitArgs reads flags", () => {
  const a = parseEmitArgs(["--from=claude", "--source=hook-command", "--point=turn.started"]);
  expect(a).toEqual({ from: "claude", source: "hook-command", point: "turn.started", attach: false, profile: null, cursorFile: null });
});

test("runEmit posts a normalized event to the hub", async () => {
  const stateDir = tmp();
  const posted: any[] = [];
  const fakeFetch = (async (_url: string, init: any) => {
    posted.push(...JSON.parse(init.body));
    return new Response(null, { status: 202 });
  }) as unknown as typeof fetch;

  await runEmit(["--from=claude", "--source=hook-command", "--point=turn.started"], {
    registry: reg(),
    env: { AGMUX_SESSION_ID: "sid-1", AGMUX_HUB_URL: "http://hub" },
    stdin: JSON.stringify({ turn_id: "t9" }),
    host: "h", stateDir, fetchImpl: fakeFetch,
  });

  expect(posted).toHaveLength(1);
  expect(posted[0].kind).toBe("turn.started");
  expect(posted[0].session_id).toBe("sid-1");
  expect(posted[0].payload.turn_id).toBe("t9");
});

test("runEmit drops the event (no throw, nothing posted) when AGMUX_SESSION_ID is absent", async () => {
  const stateDir = tmp();
  let called = false;
  const fakeFetch = (async () => { called = true; return new Response(null, { status: 202 }); }) as unknown as typeof fetch;
  await runEmit(["--from=claude", "--source=hook-command", "--point=turn.started"], {
    registry: reg(), env: {}, stdin: "{}", host: "h", stateDir, fetchImpl: fakeFetch,
  });
  expect(called).toBe(false);
});

test("runEmit queues to disk when the hub POST fails", async () => {
  const stateDir = tmp();
  const failing = (async () => { throw new Error("network"); }) as unknown as typeof fetch;
  await runEmit(["--from=claude", "--source=hook-command", "--point=turn.started"], {
    registry: reg(),
    env: { AGMUX_SESSION_ID: "sid-q", AGMUX_HUB_URL: "http://hub" },
    stdin: "{}", host: "h", stateDir, fetchImpl: failing,
  });
  const qf = path.join(stateDir, "queue", "sid-q.jsonl");
  expect(fs.existsSync(qf)).toBe(true);
  expect(fs.readFileSync(qf, "utf8").trim().length).toBeGreaterThan(0);
});

test("runEmit --attach emits capabilities from the ledger", async () => {
  const stateDir = tmp();
  // Seed a ledger record by installing the fake adapter for the bare claude target.
  const { installAdapter } = await import("@agmux/adapters");
  installAdapter(fakeAdapter, { agentKind: "claude", profile: null, profileEnv: { FAKE_CONFIG_DIR: path.join(stateDir, "cfg") }, agmuxEmitPath: "x", stateDir });

  const posted: any[] = [];
  const fakeFetch = (async (_u: string, init: any) => { posted.push(...JSON.parse(init.body)); return new Response(null, { status: 202 }); }) as unknown as typeof fetch;
  await runEmit(["--from=claude", "--attach"], {
    registry: reg(), env: { AGMUX_SESSION_ID: "sid-a", AGMUX_HUB_URL: "http://hub" },
    stdin: "", host: "h", stateDir, fetchImpl: fakeFetch,
  });
  expect(posted).toHaveLength(1);
  expect(posted[0].kind).toBe("session.adapter_attached");
  expect(posted[0].payload.capabilities["turn.started"].fulfil).toBe("yes");
});

test("runEmit never throws on an unknown agent_kind", async () => {
  const stateDir = tmp();
  await runEmit(["--from=codex", "--source=hook-command", "--point=turn.started"], {
    registry: reg(), env: { AGMUX_SESSION_ID: "s", AGMUX_HUB_URL: "http://hub" }, stdin: "{}", host: "h", stateDir,
  });
  // No adapter for codex in this registry → returns quietly. (No assertion needed; absence of throw is the test.)
});

test("runEmit posts the NATIVE identity form when the adapter resolves a native id", async () => {
  const stateDir = tmp();
  const posted: any[] = [];
  const fakeFetch = (async (_url: string, init: any) => {
    posted.push(...JSON.parse(init.body));
    return new Response(null, { status: 202 });
  }) as unknown as typeof fetch;

  await runEmit(["--from=claude", "--source=hook-command", "--point=turn.started"], {
    registry: reg(),
    env: { FAKE_NATIVE_ID: "nat-7", AGMUX_SESSION_ID: "claim-7", AGMUX_HUB_URL: "http://hub" },
    stdin: "{}", host: "h", stateDir, fetchImpl: fakeFetch,
  });

  expect(posted).toHaveLength(1);
  expect(posted[0].session_id).toBeUndefined();
  expect(posted[0].identity).toEqual({ agent_kind: "claude", native_session_id: "nat-7" });
  expect(posted[0].claim_session_id).toBe("claim-7");
});

test("runEmit queues under the native id when the hub POST fails", async () => {
  const stateDir = tmp();
  const failing = (async () => { throw new Error("network"); }) as unknown as typeof fetch;
  await runEmit(["--from=claude", "--source=hook-command", "--point=turn.started"], {
    registry: reg(),
    env: { FAKE_NATIVE_ID: "nat-q", AGMUX_HUB_URL: "http://hub" }, // no AGMUX_SESSION_ID at all
    stdin: "{}", host: "h", stateDir, fetchImpl: failing,
  });
  expect(fs.existsSync(path.join(stateDir, "queue", "nat-q.jsonl"))).toBe(true);
});

test("runEmit drops when neither a native id nor AGMUX_SESSION_ID is available", async () => {
  const stateDir = tmp();
  let called = false;
  const fakeFetch = (async () => { called = true; return new Response(null, { status: 202 }); }) as unknown as typeof fetch;
  await runEmit(["--from=claude", "--source=hook-command", "--point=turn.started"], {
    registry: reg(), env: {}, stdin: "{}", host: "h", stateDir, fetchImpl: fakeFetch,
  });
  expect(called).toBe(false);
});

test("ambient codex self-registers from the stdin session_id (no AGMUX_SESSION_ID)", async () => {
  // Regression: codex exposes its session id only in hook STDIN, not env. A bare
  // `codex` launch (no wrapper, no AGMUX_SESSION_ID) must still register under its
  // native id — previously the identity guard dropped it before stdin was parsed.
  const stateDir = tmp();
  const posted: any[] = [];
  const fakeFetch = (async (_u: string, init: any) => { posted.push(...JSON.parse(init.body)); return new Response(null, { status: 202 }); }) as unknown as typeof fetch;

  await runEmit(["--from=codex", "--source=hook-command", "--point=session.registered"], {
    registry: createDefaultRegistry(),
    env: { AGMUX_HUB_URL: "http://hub" }, // no AGMUX_SESSION_ID — ambient launch
    stdin: JSON.stringify({ session_id: "cdx-1", cwd: "/work", hook_event_name: "SessionStart", source: "startup" }),
    host: "h", stateDir, fetchImpl: fakeFetch,
  });

  expect(posted).toHaveLength(1);
  expect(posted[0].session_id).toBeUndefined();
  expect(posted[0].identity).toEqual({ agent_kind: "codex", native_session_id: "cdx-1" });
  expect(posted[0].payload.native_session_id).toBe("cdx-1");
});

test("fills tmux_session/window on session.registered when pane resolves", async () => {
  const events = [{ kind: "session.registered", payload: { tmux_session: null, tmux_window: null, tmux_pane: "%7" } }] as any;
  await enrichTmuxCoords(events, { TMUX_PANE: "%7" }, async () => ({ session: "agmux", window: "@4" }));
  expect(events[0].payload).toMatchObject({ tmux_session: "agmux", tmux_window: "@4" });
});

test("leaves coords null when resolver returns null", async () => {
  const events = [{ kind: "session.registered", payload: { tmux_session: null, tmux_window: null, tmux_pane: "%7" } }] as any;
  await enrichTmuxCoords(events, { TMUX_PANE: "%7" }, async () => null);
  expect(events[0].payload).toMatchObject({ tmux_session: null, tmux_window: null });
});

test("records tmux_socket from TMUX env even when resolution misses", async () => {
  const events = [{ kind: "session.registered", payload: { tmux_session: null, tmux_window: null, tmux_pane: "%7" } }] as any;
  await enrichTmuxCoords(events, { TMUX_PANE: "%7", TMUX: "/tmp/sock,1234,0" }, async () => null);
  expect(events[0].payload.tmux_socket).toBe("/tmp/sock");
});

test("tmux_socket is null on the ambient server (no TMUX socket field)", async () => {
  const events = [{ kind: "session.registered", payload: { tmux_session: null, tmux_window: null, tmux_pane: "%7" } }] as any;
  await enrichTmuxCoords(events, { TMUX_PANE: "%7" }, async () => ({ session: "agmux", window: "@4" }));
  expect(events[0].payload.tmux_socket).toBeNull();
});

test("no-ops when not in tmux (no TMUX_PANE)", async () => {
  const events = [{ kind: "session.registered", payload: { tmux_session: null, tmux_window: null, tmux_pane: null } }] as any;
  await enrichTmuxCoords(events, {}, async () => ({ session: "x", window: "@1" }));
  expect(events[0].payload).toMatchObject({ tmux_session: null, tmux_window: null });
});

test("runEmit discovers the hub via the port file when AGMUX_HUB_URL is unset", async () => {
  const stateDir = tmp();
  fs.writeFileSync(path.join(stateDir, "hub.port"), "54321\n");
  let postedUrl = "";
  const posted: any[] = [];
  const fakeFetch = (async (url: string, init: any) => {
    postedUrl = String(url);
    posted.push(...JSON.parse(init.body));
    return new Response(null, { status: 202 });
  }) as unknown as typeof fetch;

  await runEmit(["--from=claude", "--source=hook-command", "--point=turn.started"], {
    registry: reg(),
    env: { FAKE_NATIVE_ID: "nat-d" }, // no AGMUX_HUB_URL, no AGMUX_SESSION_ID — must discover
    stdin: "{}", host: "h", stateDir, fetchImpl: fakeFetch,
  });

  expect(postedUrl).toBe("http://127.0.0.1:54321/ingest");
  expect(posted).toHaveLength(1);
  expect(fs.existsSync(path.join(stateDir, "queue", "nat-d.jsonl"))).toBe(false);
});
