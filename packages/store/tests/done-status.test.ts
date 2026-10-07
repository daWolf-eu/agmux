import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { WORKING_TIMEOUT_MS } from "@agmux/protocol";
import { runMigrations } from "../src/migrations.ts";
import { applyEventToProjection } from "../src/project.ts";
import { listSessions, getSessionRaw, explainSession } from "../src/queries.ts";

// Native rows: no heartbeat staleness, so `now` only matters for the working
// timeout.
function db0(sid = "s1"): Database {
  const db = new Database(":memory:");
  runMigrations(db);
  lastTs = "2026-09-11T10:00:00.000Z";
  reg(db, sid);
  return db;
}

function reg(db: Database, sid: string) {
  applyEventToProjection(db, {
    event_id: `reg-${sid}`, ts: "2026-09-11T10:00:00.000Z", session_id: sid, kind: "session.registered",
    version: 1, host: "h", payload: { native_session_id: `n-${sid}`, agent_kind: "claude", pid: 1, cwd: "/tmp" },
  } as any);
}

let n = 0;
let lastTs = "2026-09-11T10:00:00.000Z";
function ev(db: Database, kind: string, ts: string, payload: any = {}, sid = "s1") {
  if (ts > lastTs) lastTs = ts;
  applyEventToProjection(db, { event_id: `e-${n++}`, ts, session_id: sid, kind, version: 1, host: "h", payload } as any);
}

const T = (m: number, s = 0) => `2026-09-11T10:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.000Z`;
// "Now" = just after the newest event, well inside the working timeout.
const nowish = () => new Date(Date.parse(lastTs) + 1000);
const status = (db: Database, sid = "s1") => getSessionRaw(db, sid, nowish())!.status;

test("a fresh session with no attention event is idle", () => {
  expect(status(db0())).toBe("idle");
});

test("a finished turn nobody looked at is done", () => {
  const db = db0();
  ev(db, "turn.started", T(1));
  ev(db, "turn.ended", T(2));
  expect(status(db)).toBe("done");
});

test("seeing a done session makes it idle", () => {
  const db = db0();
  ev(db, "turn.started", T(1));
  ev(db, "turn.ended", T(2));
  ev(db, "session.seen", T(3), { source: "focus" });
  expect(status(db)).toBe("idle");
});

test("a new attention event after being seen makes it done again", () => {
  const db = db0();
  ev(db, "turn.ended", T(1));
  ev(db, "session.seen", T(2), { source: "attach" });
  ev(db, "turn.ended", T(3));
  expect(status(db)).toBe("done");
});

test("waiting has no seen/unseen split: it stays waiting after a seen", () => {
  const db = db0();
  ev(db, "input.required", T(1), { kind: "permission" });
  ev(db, "session.seen", T(2), { source: "dismiss" });
  expect(status(db)).toBe("waiting");
});

test("typing a prompt marks the previous result seen", () => {
  const db = db0();
  ev(db, "turn.ended", T(1));
  ev(db, "turn.started", T(2));
  expect(status(db)).toBe("running");
  // ...so an interrupt that never sends Stop leaves it idle, not done.
  ev(db, "title.changed", T(3), { title: "x", activity: "idle" });
  expect(status(db)).toBe("idle");
  expect(getSessionRaw(db, "s1", nowish())!.seen_source).toBe("prompt");
});

test("tool.used does NOT make a session done", () => {
  const db = db0();
  ev(db, "tool.used", T(1), { tool: "Bash" });
  expect(status(db)).toBe("idle");
});

test("an out-of-order seen event never moves the marker backwards", () => {
  const db = db0();
  ev(db, "session.seen", T(5), { source: "dismiss" });
  ev(db, "session.seen", T(1), { source: "attach" });
  ev(db, "turn.ended", T(3));
  expect(status(db)).toBe("idle");
  expect(getSessionRaw(db, "s1", nowish())!.seen_source).toBe("dismiss");
});

test("status filter: done and the attention group", () => {
  const db = db0("a");
  reg(db, "b"); reg(db, "c");
  ev(db, "turn.ended", T(1), {}, "a");
  ev(db, "input.required", T(1), { kind: "permission" }, "b");
  const ids = (st: any) => listSessions(db, { statuses: st, now: nowish() }).map((r) => r.session_id).sort();
  expect(ids(["done"])).toEqual(["a"]);
  expect(ids(["waiting", "done"])).toEqual(["a", "b"]);
  expect(ids(["idle"])).toEqual(["c"]);
});

test("getSessionRaw and listSessions derive the same status (regression fence)", () => {
  const db = db0("a");
  reg(db, "b");
  ev(db, "turn.ended", T(1), {}, "a");
  for (const sid of ["a", "b"]) {
    expect(getSessionRaw(db, sid, nowish())!.status)
      .toBe(listSessions(db, { now: nowish() }).find((r) => r.session_id === sid)!.status);
  }
});

// --- waiting → running edge (PreToolUse) ---------------------------------------

test("tool.started after a permission prompt flips waiting back to running", () => {
  const db = db0();
  ev(db, "turn.started", T(1));
  ev(db, "input.required", T(2), { kind: "permission" });
  ev(db, "tool.started", T(3), { tool: "Bash" });
  const r = getSessionRaw(db, "s1", nowish())!;
  expect(r.status).toBe("running");
  expect(r.last_tool).toBe("Bash");
  expect(r.last_input_kind).toBeNull();
});

test("a tool.started that arrives late (older ts) cannot un-wait the session", () => {
  const db = db0();
  ev(db, "turn.started", T(1));
  ev(db, "input.required", T(2, 1), { kind: "permission" });
  ev(db, "tool.started", T(2, 0), { tool: "Bash" }); // fired first, delivered second
  expect(status(db)).toBe("waiting");
});

test("a late tool.started from the finished turn cannot reopen it", () => {
  const db = db0();
  ev(db, "turn.started", T(1));
  ev(db, "turn.ended", T(3));
  ev(db, "tool.started", T(2), { tool: "Read" });
  expect(status(db)).toBe("done");
});

test("a permission prompt for a pending question keeps the question and its episode", () => {
  const db = db0();
  ev(db, "input.required", T(1), { kind: "question" });
  const before = getSessionRaw(db, "s1", nowish())!.attention_ts;
  ev(db, "input.required", T(2), { kind: "permission" });
  const r = getSessionRaw(db, "s1", nowish())!;
  expect(r.status).toBe("waiting");
  expect(r.last_input_kind).toBe("question");
  expect(r.attention_ts).toBe(before);
});

test("input.received ends the wait", () => {
  const db = db0();
  ev(db, "input.required", T(1), { kind: "question" });
  ev(db, "input.received", T(2));
  expect(status(db)).toBe("running");
});

// --- title signal ------------------------------------------------------------

test("a working title starts a turn whose hook we missed", () => {
  const db = db0();
  ev(db, "title.changed", T(1), { title: "fix tests", activity: "working" });
  const r = getSessionRaw(db, "s1", nowish())!;
  expect(r.status).toBe("running");
  expect(r.title).toBe("fix tests");
});

test("an idle title ends a running turn without making it done", () => {
  const db = db0();
  ev(db, "turn.started", T(1));
  ev(db, "title.changed", T(2), { title: "x", activity: "idle" });
  expect(status(db)).toBe("idle");
});

test("an idle title never clears a waiting session", () => {
  const db = db0();
  ev(db, "input.required", T(1), { kind: "permission" });
  ev(db, "title.changed", T(2), { title: "x", activity: "idle" });
  expect(status(db)).toBe("waiting");
});

test("a working keepalive does not un-wait a session; a change to working does", () => {
  const db = db0();
  ev(db, "title.changed", T(1), { title: "x", activity: "working" });
  ev(db, "input.required", T(2), { kind: "permission" });
  ev(db, "title.changed", T(3), { title: "x", activity: "working" }); // keepalive
  expect(status(db)).toBe("waiting");
  ev(db, "title.changed", T(4), { title: "x", activity: "idle" });
  ev(db, "title.changed", T(5), { title: "x", activity: "working" });
  expect(status(db)).toBe("running");
});

// --- working timeout -----------------------------------------------------------

test("running with no evidence of work decays to idle", () => {
  const db = db0();
  ev(db, "turn.started", T(1));
  const at = (ms: number) => getSessionRaw(db, "s1", new Date(Date.parse(T(1)) + ms))!.status;
  expect(at(WORKING_TIMEOUT_MS - 1000)).toBe("running");
  expect(at(WORKING_TIMEOUT_MS + 1000)).toBe("idle");
});

test("tool and title activity keep a running session alive", () => {
  const db = db0();
  ev(db, "turn.started", T(1));
  ev(db, "tool.used", T(3), { tool: "Bash" });
  ev(db, "title.changed", T(4), { title: "x", activity: "working" });
  const s = getSessionRaw(db, "s1", new Date(Date.parse(T(4)) + WORKING_TIMEOUT_MS - 1000))!.status;
  expect(s).toBe("running");
});

// --- explain -------------------------------------------------------------------

test("explainSession names the rule, the setting event and the seen/attention markers", () => {
  const db = db0();
  ev(db, "turn.started", T(1));
  ev(db, "turn.ended", T(2));
  const d = explainSession(db, "s1", nowish())!;
  expect(d.status).toBe("done");
  expect(d.stored_status).toBe("idle");
  expect(d.rule).toBe("unseen");
  expect(d.status_event).toEqual({ kind: "turn.ended", ts: T(2) });
  expect(d.attention).toEqual({ kind: "turn.ended", ts: T(2) });
  expect(d.seen).toEqual({ source: "prompt", ts: T(1) });
});

test("explainSession reports the working timeout", () => {
  const db = db0();
  ev(db, "turn.started", T(1));
  const d = explainSession(db, "s1", new Date(Date.parse(T(1)) + WORKING_TIMEOUT_MS + 1))!;
  expect(d.status).toBe("idle");
  expect(d.rule).toBe("working-timeout");
  expect(explainSession(db, "missing", nowish())).toBeNull();
});
