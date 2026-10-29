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

test("GET /sessions?status=closed returns only ended/lost", async () => {
  const { server, url } = makeServer();
  await fetch(`${url}/ingest`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(startedEv) });
  await fetch(`${url}/ingest`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      event_id: "01HZ7P0K8WVQH8WGS8X9DC9F40",
      ts: new Date(Date.now() + 1000).toISOString(),
      session_id: startedEv.session_id,
      kind: "session.ended", version: 1, host: "macbook.local",
      payload: { exit_code: 0, signal: null, reason: "normal" } }) });
  const closed = await (await fetch(`${url}/sessions?status=closed`)).json() as any;
  expect(closed.sessions).toHaveLength(1);
  expect(closed.sessions[0].status).toBe("ended");
  const active = await (await fetch(`${url}/sessions?status=active`)).json() as any;
  expect(active.sessions).toHaveLength(0);
  server.stop();
});

test("GET /sessions?sort=started&order=asc orders oldest first", async () => {
  const { server, url } = makeServer();
  const older = { ...startedEv, event_id: "01HZ7P0K8WVQH8WGS8X9DC9F41",
    session_id: "0190a3e0-0000-7000-8000-00000000000a",
    ts: new Date(Date.now() - 60_000).toISOString() };
  await fetch(`${url}/ingest`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify([older, startedEv]) });
  const asc = await (await fetch(`${url}/sessions?sort=started&order=asc`)).json() as any;
  expect(asc.sessions.map((s: any) => s.session_id)).toEqual([older.session_id, startedEv.session_id]);
  const desc = await (await fetch(`${url}/sessions?sort=started&order=desc`)).json() as any;
  expect(desc.sessions.map((s: any) => s.session_id)).toEqual([startedEv.session_id, older.session_id]);
  server.stop();
});

test("GET /sessions rejects invalid sort/order/status with 400", async () => {
  const { server, url } = makeServer();
  expect((await fetch(`${url}/sessions?sort=bogus`)).status).toBe(400);
  expect((await fetch(`${url}/sessions?order=sideways`)).status).toBe(400);
  expect((await fetch(`${url}/sessions?status=bogus`)).status).toBe(400);
  server.stop();
});

// --- replication / remote rows ---

const HOST_SYNCED = {
  event_id: "h-synced-1", ts: new Date().toISOString(),
  session_id: "00000000-0000-0000-0000-000000000000",
  kind: "host.synced", version: 1, host: "gw/sbx",
  payload: {
    remote: "gw/sbx", transport: { kind: "openshell", gateway: "gw", target: "sbx", bin: "openshell" },
    cursor: 1, db_id: "db1", agmux_version: "0.1.0", replication: 1, rejected: 0,
  },
};
const REMOTE_SID = "0190a3e0-0000-7000-8000-000000000009";
const remoteRegistered = {
  event_id: "r-reg-1", ts: new Date().toISOString(), session_id: REMOTE_SID,
  kind: "session.registered", version: 1, host: "gw/sbx",
  payload: { agent_kind: "claude", tmux_session: "main", tmux_window: "1", tmux_pane: "%3",
    cwd: "/tmp", profile: null, agent_version: null, parent: null, native_session_id: null, pid: 42 },
} as any;

function post(url: string, body: unknown) {
  return fetch(`${url}/ingest`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

test("GET /health includes db_id", async () => {
  const { server, url, store } = makeServer();
  const body = (await (await fetch(`${url}/health`)).json()) as { db_id: string };
  expect(body.db_id).toBe(store.dbId());
  server.stop();
});

test("GET /events?after_id returns exportable records in id order with last_id", async () => {
  const { server, url } = makeServer();
  await post(url, startedEv);
  const r = await fetch(`${url}/events?after_id=0`);
  expect(r.status).toBe(200);
  const body = (await r.json()) as { records: { id: number; ev: { event_id: string } }[]; last_id: number };
  expect(body.records.length).toBeGreaterThan(0);
  const ids = body.records.map((x) => x.id);
  expect([...ids].sort((a, b) => a - b)).toEqual(ids);
  expect(body.last_id).toBe(ids[ids.length - 1]!);
  const after = (await (await fetch(`${url}/events?after_id=${body.last_id}`)).json()) as { records: unknown[] };
  expect(after.records).toHaveLength(0);
  server.stop();
});

test("GET /events?after_id rejects invalid after_id and limit", async () => {
  const { server, url } = makeServer();
  for (const q of ["after_id=abc", "after_id=-1", "after_id=1.5", "after_id="]) {
    const r = await fetch(`${url}/events?${q}`);
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: "invalid_after_id" });
  }
  for (const q of ["limit=0", "limit=-3", "limit=x", "limit=1.5"]) {
    const r = await fetch(`${url}/events?after_id=0&${q}`);
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: "invalid_limit" });
  }
  server.stop();
});

test("GET /events?after_id honours limit and clamps to 5000", async () => {
  const { server, url } = makeServer();
  await post(url, [startedEv, { ...startedEv, event_id: "01HZ7P0K8WVQH8WGS8X9DC9F2Q", kind: "session.heartbeat",
    payload: { pid_alive: true, winsize: { rows: 40, cols: 100 } } }]);
  const one = (await (await fetch(`${url}/events?after_id=0&limit=1`)).json()) as { records: unknown[] };
  expect(one.records).toHaveLength(1);
  const big = await fetch(`${url}/events?after_id=0&limit=999999`);
  expect(big.status).toBe(200);
  server.stop();
});

test("GET /sessions?locality filters local vs remote; invalid -> 400", async () => {
  const { server, url, store } = makeServer();
  store.append(HOST_SYNCED as any);
  store.appendReplicated(remoteRegistered, "gw/sbx", "db-1");
  await post(url, startedEv);
  const remote = (await (await fetch(`${url}/sessions?locality=remote`)).json()) as { sessions: { session_id: string }[] };
  expect(remote.sessions.map((s) => s.session_id)).toEqual([REMOTE_SID]);
  const local = (await (await fetch(`${url}/sessions?locality=local`)).json()) as { sessions: { session_id: string }[] };
  expect(local.sessions.map((s) => s.session_id)).toEqual([startedEv.session_id]);
  const byHost = (await (await fetch(`${url}/sessions?host=gw/*`)).json()) as { sessions: { session_id: string }[] };
  expect(byHost.sessions.map((s) => s.session_id)).toEqual([REMOTE_SID]);
  const bad = await fetch(`${url}/sessions?locality=x`);
  expect(bad.status).toBe(400);
  expect(await bad.json()).toEqual({ error: "invalid_locality" });
  server.stop();
});

test("GET /hosts lists a host after host.synced", async () => {
  const { server, url, store } = makeServer();
  store.append(HOST_SYNCED as any);
  const body = (await (await fetch(`${url}/hosts`)).json()) as { hosts: { host: string; last_sync_ok: boolean }[] };
  expect(body.hosts).toHaveLength(1);
  expect(body.hosts[0]!.host).toBe("gw/sbx");
  expect(body.hosts[0]!.last_sync_ok).toBe(true);
  server.stop();
});

test("POST /ingest rejects host.* kinds with reserved_kind", async () => {
  const { server, url, store } = makeServer();
  const r = await post(url, HOST_SYNCED);
  expect(r.status).toBe(400);
  expect(await r.json()).toEqual({ error: "reserved_kind" });
  expect(store.listHosts()).toHaveLength(0);
  // also rejected inside a batch
  const r2 = await post(url, [{ ...HOST_SYNCED, kind: "host.removed", event_id: "h2", payload: { remote: "gw/sbx" } }]);
  expect(r2.status).toBe(400);
  server.stop();
});

test("POST /ingest rejects a body over 1 MiB with 413 (with and without content-length)", async () => {
  const { server, url, store } = makeServer();
  const big = JSON.stringify({ ...startedEv, payload: { ...startedEv.payload, cwd: "x".repeat(1 << 20) } });
  const r = await fetch(`${url}/ingest`, { method: "POST", headers: { "content-type": "application/json" }, body: big });
  expect(r.status).toBe(413);
  const enc = new TextEncoder().encode(big);
  const chunked = new ReadableStream<Uint8Array>({
    start(c) { for (let i = 0; i < enc.length; i += 65536) c.enqueue(enc.subarray(i, i + 65536)); c.close(); },
  });
  const r2 = await fetch(`${url}/ingest`, { method: "POST", headers: { "content-type": "application/json" }, body: chunked });
  expect(r2.status).toBe(413);
  expect(store.rawDb().query("SELECT COUNT(*) AS n FROM events").get()).toEqual({ n: 0 });
  const ok = await fetch(`${url}/ingest`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(startedEv) });
  expect(ok.status).toBe(202);
  server.stop();
});

test("GET /hosts carries the sync loop's remotes (empty without one)", async () => {
  const { server, url } = makeServer();
  expect(((await (await fetch(`${url}/hosts`)).json()) as { remotes: unknown[] }).remotes).toEqual([]);
  server.stop();
  const state = [{ name: "lab", gateway: "gw", last_discovery_ts: null, nodes: 0 }];
  const s2 = createServer({ store: Store.openInMemory(), port: 0, remotes: () => state });
  const body = (await (await fetch(`http://${s2.hostname}:${s2.port}/hosts`)).json()) as { hosts: unknown[]; remotes: unknown[] };
  expect(body).toEqual({ hosts: [], remotes: state });
  s2.stop();
});

test("POST /hosts/<host>/sync kicks the follower: 204 known, 404 unknown or without a sync loop", async () => {
  const kicked: string[] = [];
  const s = createServer({ store: Store.openInMemory(), port: 0, kickHost: (h) => { kicked.push(h); return h === "gw/sbx"; } });
  const base = `http://${s.hostname}:${s.port}`;
  expect((await fetch(`${base}/hosts/${encodeURIComponent("gw/sbx")}/sync`, { method: "POST" })).status).toBe(204);
  const miss = await fetch(`${base}/hosts/${encodeURIComponent("gw/nope")}/sync`, { method: "POST" });
  expect(miss.status).toBe(404);
  expect(await miss.json()).toEqual({ error: "not_found" });
  expect((await fetch(`${base}/hosts/%E0%A4%A/sync`, { method: "POST" })).status).toBe(404);
  expect(kicked).toEqual(["gw/sbx", "gw/nope"]);
  s.stop();
  const { server, url } = makeServer();
  expect((await fetch(`${url}/hosts/gw%2Fsbx/sync`, { method: "POST" })).status).toBe(404);
  server.stop();
});
