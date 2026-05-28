import { test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Store } from "@agmux/store";
import { createServer } from "@agmux/hub";

let tmp: string;
let server: ReturnType<typeof createServer>;
let url: string;
let store: Store;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agmux-lost-"));
  store = Store.openInMemory();
  server = createServer({ store, port: 0 });
  url = `http://${server.hostname}:${server.port}`;
});
afterEach(() => server.stop());

test("session with stale heartbeat surfaces as 'lost'", async () => {
  const sid = "0190a3e0-0000-7000-8000-000000000000";
  await fetch(`${url}/ingest`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      event_id: "01HZ7P0K8WVQH8WGS8X9DC9F2P",
      ts: "2026-05-28T11:00:00.000Z",
      session_id: sid,
      kind: "session.started", version: 1, host: "h",
      payload: { agent_kind: "claude", profile: "p", command: "x",
        args: [], env_overrides: {}, cwd: "/", pid: 1,
        tmux_session: null, tmux_window: null, tmux_pane: null, project: null },
    }),
  });
  const r = await fetch(`${url}/sessions?all=1`);
  const body = await r.json();
  expect(body.sessions[0].status).toBe("lost");
});
