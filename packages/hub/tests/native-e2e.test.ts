import { test, expect } from "bun:test";
import { Store } from "@agmux/store";
import { createServer } from "../src/server.ts";
import { sweepNativeLiveness } from "../src/liveness.ts";
import { stampIngestEvents } from "@agmux/adapters";

function makeServer() {
  const store = Store.openInMemory();
  const server = createServer({ store, port: 0 });
  return { store, server, url: `http://${server.hostname}:${server.port}` };
}
async function post(url: string, body: unknown) {
  return fetch(`${url}/ingest`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

test("native session lifecycle: register → mint, re-register dead session → reopen, pid-sweep → lost", async () => {
  const { store, server, url } = makeServer();

  // 1. A native session.registered (as emit would stamp it) mints a session.
  const [reg] = stampIngestEvents(
    [{ kind: "session.registered", payload: {
        native_session_id: "nat-e2e", agent_kind: "claude", pid: 999999, cwd: "/tmp",
        tmux_session: null, tmux_window: null, tmux_pane: "%1", profile: null, agent_version: null, parent: null }, dedup_key: null }],
    { agentKind: "claude", nativeId: "nat-e2e", claimId: null, host: "macbook.local" },
  );
  await post(url, reg);
  const minted = store.listSessions({}).find((s) => s.native_session_id === "nat-e2e")!;
  expect(minted.origin).toBe("native");
  const sid = minted.session_id;

  // 2. pid 999999 is (almost certainly) dead → sweep marks it lost.
  const lost = sweepNativeLiveness(store, { host: "macbook.local", isAlive: () => false });
  expect(lost).toBe(1);
  expect(store.getSession(sid)!.status).toBe("lost");

  // 3. Re-registering the SAME native id reopens the same canonical session (rule 1).
  await post(url, reg);
  expect(store.getSession(sid)!.status).toBe("idle");
  // Still exactly one session for this native id — no duplicate minted.
  expect(store.listSessions({}).filter((s) => s.native_session_id === "nat-e2e")).toHaveLength(1);

  server.stop();
});
