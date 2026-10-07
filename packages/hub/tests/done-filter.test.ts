import { test, expect } from "bun:test";
import { Store } from "@agmux/store";
import { createServer } from "../src/server.ts";

function makeServer() {
  const store = Store.openInMemory();
  const server = createServer({ store, port: 0 });
  return { store, server, url: `http://${server.hostname}:${server.port}` };
}

const now = Date.now();
const iso = (dt: number) => new Date(now + dt).toISOString();
const sidA = "0190a3e0-0000-7000-8000-00000000000a";
const sidB = "0190a3e0-0000-7000-8000-00000000000b";

function started(sid: string, id: string) {
  return {
    event_id: id, ts: iso(-2000), session_id: sid, kind: "session.started", version: 1, host: "h",
    payload: {
      agent_kind: "claude", profile: null, command: "claude", args: [], env_overrides: {}, cwd: "/tmp", pid: 4242,
      tmux_session: "agmux", tmux_window: "@1", tmux_pane: "%1", project: null,
    },
  };
}

async function post(url: string, body: unknown) {
  const r = await fetch(`${url}/ingest`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  expect(r.status).toBe(202);
}

test("GET /sessions?status=done returns finished-and-unseen sessions; attention adds waiting", async () => {
  const { server, url } = makeServer();
  await post(url, [started(sidA, "01HZ7P0K8WVQH8WGS8X9DC9F2A"), started(sidB, "01HZ7P0K8WVQH8WGS8X9DC9F2B")]);
  await post(url, { event_id: "01HZ7P0K8WVQH8WGS8X9DC9F2C", ts: iso(-1000), session_id: sidA, kind: "turn.ended", version: 1, host: "h", payload: {} });
  await post(url, { event_id: "01HZ7P0K8WVQH8WGS8X9DC9F2D", ts: iso(-1000), session_id: sidB, kind: "input.required", version: 1, host: "h", payload: { kind: "question" } });

  const done = await (await fetch(`${url}/sessions?status=done`)).json() as any;
  expect(done.sessions.map((s: any) => s.session_id)).toEqual([sidA]);
  expect(done.sessions[0].status).toBe("done");

  const attention = await (await fetch(`${url}/sessions?status=attention`)).json() as any;
  expect(attention.sessions.map((s: any) => s.session_id).sort()).toEqual([sidA, sidB]);

  // Seen → idle
  await post(url, { event_id: "01HZ7P0K8WVQH8WGS8X9DC9F2E", ts: iso(-500), session_id: sidA, kind: "session.seen", version: 1, host: "h", payload: { source: "focus" } });
  const after = await (await fetch(`${url}/sessions?status=done`)).json() as any;
  expect(after.sessions).toHaveLength(0);
  server.stop();
});

test("GET /sessions/:id/explain returns the status decision", async () => {
  const { server, url } = makeServer();
  await post(url, started(sidA, "01HZ7P0K8WVQH8WGS8X9DC9F2F"));
  await post(url, { event_id: "01HZ7P0K8WVQH8WGS8X9DC9F2G", ts: iso(-1000), session_id: sidA, kind: "turn.ended", version: 1, host: "h", payload: {} });
  const body = await (await fetch(`${url}/sessions/${sidA}/explain`)).json() as any;
  expect(body.decision.status).toBe("done");
  expect(body.decision.rule).toBe("unseen");
  expect(body.decision.status_event.kind).toBe("turn.ended");
  expect((await fetch(`${url}/sessions/nope/explain`)).status).toBe(404);
  server.stop();
});

test("session.seen rejects unknown sources", async () => {
  const { server, url } = makeServer();
  const r = await fetch(`${url}/ingest`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event_id: "01HZ7P0K8WVQH8WGS8X9DC9F2H", ts: iso(0), session_id: sidA, kind: "session.seen", version: 1, host: "h", payload: { source: "telepathy" } }),
  });
  expect(r.status).toBe(400);
  server.stop();
});
