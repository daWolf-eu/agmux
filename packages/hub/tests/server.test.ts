import { test, expect } from "bun:test";
import { Store } from "@agmux/store";
import { createServer } from "../src/server.ts";

function makeServer() {
  const store = Store.openInMemory();
  const server = createServer({ store, port: 0 });
  return { store, server, url: `http://${server.hostname}:${server.port}` };
}

// Use a fresh "now" timestamp so the live-status projection (which compares against
// real-time) treats the session as idle, not lost.
const startedEv = {
  event_id: "01HZ7P0K8WVQH8WGS8X9DC9F2P",
  ts: new Date().toISOString(),
  session_id: "0190a3e0-0000-7000-8000-000000000000",
  kind: "session.started",
  version: 1,
  host: "macbook.local",
  payload: {
    agent_kind: "claude", profile: "claude-work", command: "ccc",
    args: [], env_overrides: {}, cwd: "/tmp", pid: 4242,
    tmux_session: "agmux", tmux_window: "@1", tmux_pane: "%1", project: null,
  },
};

test("GET /health returns 200 with ok + version", async () => {
  const { server, url } = makeServer();
  const r = await fetch(`${url}/health`);
  expect(r.status).toBe(200);
  const body = (await r.json()) as { ok: boolean; version: string };
  expect(body.ok).toBe(true);
  expect(typeof body.version).toBe("string");
  expect(body.version.length).toBeGreaterThan(0);
  server.stop();
});

test("POST /ingest with a valid event returns 202 and persists", async () => {
  const { server, url, store } = makeServer();
  const r = await fetch(`${url}/ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(startedEv),
  });
  expect(r.status).toBe(202);
  expect(store.listEvents()).toHaveLength(1);
  server.stop();
});

test("POST /ingest accepts a batch array", async () => {
  const { server, url, store } = makeServer();
  const batch = [
    startedEv,
    { ...startedEv, event_id: "01HZ7P0K8WVQH8WGS8X9DC9F2Q", kind: "session.heartbeat",
      ts: "2026-05-28T12:00:30.000Z",
      payload: { pid_alive: true, winsize: { rows: 40, cols: 100 } } },
  ];
  const r = await fetch(`${url}/ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(batch),
  });
  expect(r.status).toBe(202);
  expect(store.listEvents()).toHaveLength(2);
  server.stop();
});

test("POST /ingest rejects malformed envelope with 400", async () => {
  const { server, url } = makeServer();
  const r = await fetch(`${url}/ingest`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "session.started" }),
  });
  expect(r.status).toBe(400);
  server.stop();
});

test("POST /ingest is idempotent on duplicate event_id (still 202)", async () => {
  const { server, url, store } = makeServer();
  await fetch(`${url}/ingest`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(startedEv) });
  const r = await fetch(`${url}/ingest`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(startedEv) });
  expect(r.status).toBe(202);
  expect(store.listEvents()).toHaveLength(1);
  server.stop();
});

test("GET /sessions returns all statuses by default (live filter is opt-in)", async () => {
  const { server, url } = makeServer();
  await fetch(`${url}/ingest`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(startedEv) });
  await fetch(`${url}/ingest`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      event_id: "01HZ7P0K8WVQH8WGS8X9DC9F2X",
      ts: new Date(Date.now() + 1000).toISOString(),
      session_id: startedEv.session_id,
      kind: "session.ended", version: 1, host: "macbook.local",
      payload: { exit_code: 0, signal: null, reason: "normal" } }) });
  const r = await fetch(`${url}/sessions`);
  expect(r.status).toBe(200);
  const body = await r.json() as any;
  // Ended session must appear by default — it's discoverable for `agmux attach`.
  expect(body.sessions).toHaveLength(1);
  expect(body.sessions[0].status).toBe("ended");
  server.stop();
});

test("GET /sessions?live=1 filters to live statuses only", async () => {
  const { server, url } = makeServer();
  await fetch(`${url}/ingest`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(startedEv) });
  await fetch(`${url}/ingest`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      event_id: "01HZ7P0K8WVQH8WGS8X9DC9F2Y",
      ts: new Date(Date.now() + 1000).toISOString(),
      session_id: startedEv.session_id,
      kind: "session.ended", version: 1, host: "macbook.local",
      payload: { exit_code: 0, signal: null, reason: "normal" } }) });
  const r = await fetch(`${url}/sessions?live=1`);
  const body = await r.json() as any;
  // The session is now ended; live filter excludes it.
  expect(body.sessions).toHaveLength(0);
  server.stop();
});

test("GET /sessions/:id returns row plus recent events", async () => {
  const { server, url } = makeServer();
  await fetch(`${url}/ingest`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(startedEv) });
  const r = await fetch(`${url}/sessions/${startedEv.session_id}`);
  expect(r.status).toBe(200);
  const body = await r.json() as any;
  expect(body.session.session_id).toBe(startedEv.session_id);
  expect(body.events).toHaveLength(1);
  server.stop();
});

test("GET /sessions/:id 404 when missing", async () => {
  const { server, url } = makeServer();
  const r = await fetch(`${url}/sessions/nope`);
  expect(r.status).toBe(404);
  server.stop();
});

test("GET /sessions/:id includes usage totals", async () => {
  const sid = "0190a3e0-0000-7000-8000-000000000000";
  const store = Store.openInMemory();
  const server = createServer({ store, port: 0 });
  const base = `http://${server.hostname}:${server.port}`;

  await fetch(`${base}/ingest`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      event_id: "01HZ7P0K8WVQH8WGS8X9DC9F2P", ts: "2026-05-28T12:00:00.000Z",
      session_id: sid, kind: "session.started", version: 1, host: "h",
      payload: { agent_kind: "codex", profile: null, command: "codex", args: [], env_overrides: {}, cwd: "/tmp", pid: 1, tmux_session: null, tmux_window: null, tmux_pane: null, project: null },
    }),
  });
  await fetch(`${base}/ingest`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      event_id: "01HZ7P0K8WVQH8WGS8X9DC9F2Q", ts: "2026-05-28T12:01:00.000Z",
      session_id: sid, kind: "usage.reported", version: 1, host: "h",
      payload: { cumulative: false, source: "manual-command", input_tokens: 100 },
    }),
  });

  const r = await fetch(`${base}/sessions/${sid}`);
  const body = await r.json() as any;
  expect(body.usage.input_tokens).toBe(100);
  server.stop();
  store.close();
});

test("POST /ingest mints a session for a native session.registered event", async () => {
  const { server, url, store } = makeServer();
  const wire = {
    event_id: "01HZ7P0K8WVQH8WGS8X9DC9F2Q", ts: new Date().toISOString(),
    kind: "session.registered", version: 1, host: "macbook.local",
    identity: { agent_kind: "claude", native_session_id: "nat-xyz" },
    payload: { agent_kind: "claude", native_session_id: "nat-xyz", pid: 4242, cwd: "/tmp",
      tmux_session: null, tmux_window: null, tmux_pane: "%1", profile: null, agent_version: null, parent: null },
  };
  const r = await fetch(`${url}/ingest`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(wire),
  });
  expect(r.status).toBe(202);
  const minted = store.listSessions({}).find((s) => s.native_session_id === "nat-xyz");
  expect(minted).toBeDefined();
  expect(minted!.origin).toBe("native");
  server.stop();
});

test("POST /ingest rejects an envelope with neither session_id nor identity", async () => {
  const { server, url } = makeServer();
  const bad = { event_id: "x", ts: new Date().toISOString(), kind: "turn.started", version: 1, host: "h", payload: {} };
  const r = await fetch(`${url}/ingest`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(bad),
  });
  expect(r.status).toBe(400);
  server.stop();
});
