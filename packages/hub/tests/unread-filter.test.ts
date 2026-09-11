import { test, expect } from "bun:test";
import { Store } from "@agmux/store";
import { createServer } from "../src/server.ts";

function makeServer() {
  const store = Store.openInMemory();
  const server = createServer({ store, port: 0 });
  return { store, server, url: `http://${server.hostname}:${server.port}` };
}

const startedEv = {
  event_id: "01HZ7P0K8WVQH8WGS8X9DC9F2P",
  ts: "2026-09-11T10:00:00.000Z",
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

test("GET /sessions?unread=1 returns only sessions wanting attention", async () => {
  const { server, url, store } = makeServer();
  // Seed two sessions
  await fetch(`${url}/ingest`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(startedEv),
  });
  await fetch(`${url}/ingest`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...startedEv,
      event_id: "01HZ7P0K8WVQH8WGS8X9DC9F2Q",
      session_id: "0190a3e0-0000-7000-8000-00000000000b",
    }),
  });
  // Mark the second session as unread
  await fetch(`${url}/ingest`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      event_id: "01HZ7P0K8WVQH8WGS8X9DC9F2R",
      ts: "2026-09-11T10:01:00.000Z",
      session_id: "0190a3e0-0000-7000-8000-00000000000b",
      kind: "input.required",
      version: 1,
      host: "macbook.local",
      payload: { kind: "permission" },
    }),
  });

  const filtered = await (await fetch(`${url}/sessions?unread=1`)).json() as any;
  expect(filtered.sessions).toHaveLength(1);
  expect(filtered.sessions[0]!.session_id).toBe("0190a3e0-0000-7000-8000-00000000000b");
  expect(filtered.sessions[0]!.unread).toBe(true);

  const all = await (await fetch(`${url}/sessions`)).json() as any;
  expect(all.sessions).toHaveLength(2);
  server.stop();
});

test("GET /sessions without unread filter returns all", async () => {
  const { server, url } = makeServer();
  await fetch(`${url}/ingest`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(startedEv),
  });
  await fetch(`${url}/ingest`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...startedEv,
      event_id: "01HZ7P0K8WVQH8WGS8X9DC9F2Q",
      session_id: "0190a3e0-0000-7000-8000-00000000000b",
    }),
  });

  const r = await fetch(`${url}/sessions`);
  const body = await r.json() as any;
  expect(body.sessions).toHaveLength(2);
  server.stop();
});
