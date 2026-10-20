import { test, expect } from "bun:test";
import { NO_SESSION_ID } from "@agmux/protocol";
import { Store } from "../src/index.ts";

const transport = { kind: "openshell", gateway: "gw", target: "sbx", bin: "openshell" } as const;
let n = 0;
function hev(kind: string, ts: string, payload: unknown): any {
  return { event_id: "h" + ++n, ts, session_id: NO_SESSION_ID, kind, version: 1, host: "gw/sbx", payload };
}
const synced = (ts: string, cursor: number) => hev("host.synced", ts, {
  remote: "gw/sbx", transport, cursor, db_id: "db1", agmux_version: "0.1.0", replication: 1, rejected: 2,
});
const failed = (ts: string) => hev("host.sync_failed", ts, { remote: "gw/sbx", error: "boom" });
const removed = (ts: string) => hev("host.removed", ts, { remote: "gw/sbx" });

test("host.synced -> host.sync_failed -> host.synced toggles last_sync_ok and clears last_error", () => {
  const s = Store.openInMemory();
  s.append(synced("2026-06-08T00:00:01.000Z", 5));
  expect(s.getHost("gw/sbx")).toEqual({
    host: "gw/sbx", remote: "gw/sbx", transport, last_sync_ts: "2026-06-08T00:00:01.000Z",
    last_sync_ok: true, last_error: null, cursor: 5, db_id: "db1", agmux_version: "0.1.0",
    replication: 1, rejected: 2, removed_ts: null,
  });
  s.append(failed("2026-06-08T00:00:02.000Z"));
  const f = s.getHost("gw/sbx")!;
  expect(f.last_sync_ok).toBe(false);
  expect(f.last_error).toBe("boom");
  expect(f.cursor).toBe(5);
  s.append(synced("2026-06-08T00:00:03.000Z", 9));
  const g = s.getHost("gw/sbx")!;
  expect(g.last_sync_ok).toBe(true);
  expect(g.last_error).toBeNull();
  expect(g.cursor).toBe(9);
  expect(g.last_sync_ts).toBe("2026-06-08T00:00:03.000Z");
});

test("host.removed then host.synced clears removed_ts", () => {
  const s = Store.openInMemory();
  s.append(synced("2026-06-08T00:00:01.000Z", 1));
  s.append(removed("2026-06-08T00:00:02.000Z"));
  expect(s.getHost("gw/sbx")!.removed_ts).toBe("2026-06-08T00:00:02.000Z");
  s.append(synced("2026-06-08T00:00:03.000Z", 2));
  expect(s.getHost("gw/sbx")!.removed_ts).toBeNull();
});

test("rebuildProjections rebuilds hosts", () => {
  const s = Store.openInMemory();
  s.append(synced("2026-06-08T00:00:01.000Z", 1));
  s.append(failed("2026-06-08T00:00:02.000Z"));
  s.append(removed("2026-06-08T00:00:03.000Z"));
  const before = s.listHosts();
  expect(before.length).toBe(1);
  s.rebuildProjections();
  expect(s.listHosts()).toEqual(before);
});
