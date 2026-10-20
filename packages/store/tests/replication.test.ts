import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/index.ts";

const sid = "0190a3e0-0000-7000-8000-000000000001";

function ev(id: string, over: Record<string, unknown> = {}): any {
  return {
    event_id: id, ts: "2026-06-08T00:00:00.000Z", session_id: sid,
    kind: "usage.reported", version: 1, host: "h",
    payload: { cumulative: false, source: "transcript-delta", input_tokens: 1 }, ...over,
  };
}
function registered(id: string, host: string): any {
  return ev(id, {
    kind: "session.registered", host,
    payload: { agent_kind: "claude", tmux_session: null, tmux_window: null, tmux_pane: "%1",
      cwd: "/tmp", profile: null, agent_version: null, parent: null, native_session_id: "n-1", pid: 1 },
  });
}
const count = (s: Store) => s.rawDb().query<{ n: number }, []>(`SELECT COUNT(*) n FROM events`).get()!.n;

test("appendReplicated stores source and applies the projection", () => {
  const s = Store.openInMemory();
  expect(s.appendReplicated(registered("e1", "gw/sbx"), "gw/sbx", "db-x")).toBe(true);
  expect(s.getSession(sid)).not.toBeNull();
  const r = s.rawDb().query<any, []>(`SELECT source, source_db FROM events WHERE event_id='e1'`).get();
  expect(r).toEqual({ source: "gw/sbx", source_db: "db-x" });
  expect(s.rawDb().query(`SELECT source_db FROM sessions`).get()).toEqual({ source_db: "db-x" });
});

test("appendReplicated is idempotent on event_id", () => {
  const s = Store.openInMemory();
  expect(s.appendReplicated(ev("e1"), "gw/sbx", "db-x")).toBe(true);
  expect(s.appendReplicated(ev("e1"), "gw/sbx", "db-x")).toBe(false);
  expect(count(s)).toBe(1);
});

test("appendReplicated drops dedup_key", () => {
  const s = Store.openInMemory();
  s.appendReplicated(ev("e1", { dedup_key: "k1" }), "gw/sbx", "db-x");
  const r = s.rawDb().query<any, []>(`SELECT dedup_key FROM events WHERE event_id='e1'`).get();
  expect(r.dedup_key).toBeNull();
});

test("listExportable excludes replicated rows", () => {
  const s = Store.openInMemory();
  s.append(ev("e1"));
  s.appendReplicated(ev("e2"), "gw/sbx", "db-x");
  s.append(ev("e3"));
  const r = s.listExportable(0, 10);
  expect(r.records.map((x) => x.ev.event_id)).toEqual(["e1", "e3"]);
  expect(r.last_id).toBe(r.records[1]!.id);
  expect(s.listExportable(r.last_id, 10)).toEqual({ records: [], last_id: r.last_id });
});

test("listExportable honours limit", () => {
  const s = Store.openInMemory();
  for (let i = 1; i <= 5; i++) s.append(ev("e" + i));
  const a = s.listExportable(0, 2);
  expect(a.records.map((x) => x.id)).toEqual([1, 2]);
  expect(s.listExportable(2, 2).records.map((x) => x.id)).toEqual([3, 4]);
});

test("dbId is stable across reopen and differs between stores", () => {
  const dir = mkdtempSync(join(tmpdir(), "agmux-dbid-"));
  try {
    const path = join(dir, "a.db");
    const s1 = Store.open(path);
    const id = s1.dbId();
    expect(s1.dbId()).toBe(id);
    s1.close();
    const s2 = Store.open(path);
    expect(s2.dbId()).toBe(id);
    s2.close();
    const other = Store.open(join(dir, "b.db"));
    expect(other.dbId()).not.toBe(id);
    other.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dbId is cached on the instance after the first read (no transaction per /health)", () => {
  const s = Store.openInMemory();
  const id = s.dbId();
  const db = s.rawDb();
  const orig = db.transaction.bind(db);
  let tx = 0;
  db.transaction = ((fn: any) => { tx++; return orig(fn); }) as typeof db.transaction;
  expect(s.dbId()).toBe(id);
  expect(tx).toBe(0);
});
