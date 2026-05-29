import { test, expect } from "bun:test";
import { parseEmitArgs, runEmit } from "../src/emit.ts";
import { createRegistry } from "@agmux/adapters";
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
