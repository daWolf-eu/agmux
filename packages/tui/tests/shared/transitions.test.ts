import { test, expect } from "bun:test";
import { createDetectState, detectNotifications, type DetectConfig } from "../../src/shared/transitions.ts";
import { mkRow } from "../helpers/mk-row.ts";

const CFG: DetectConfig = { delayMs: 5000, triggers: ["permission", "prompt", "turn_end", "session_end"] };
const waiting = (over = {}) => mkRow({ session_id: "s1", status: "waiting", last_input_kind: "permission", activity_ts: "t1", ...over });

test("does not fire before the debounce elapses", () => {
  const st = createDetectState();
  expect(detectNotifications(st, [waiting()], CFG, 1000)).toEqual([]);
  expect(detectNotifications(st, [waiting()], CFG, 4000)).toEqual([]);
});

test("fires once the session has waited longer than the delay", () => {
  const st = createDetectState();
  detectNotifications(st, [waiting()], CFG, 1000);
  const out = detectNotifications(st, [waiting()], CFG, 7000);
  expect(out.length).toBe(1);
  expect(out[0]!.trigger).toBe("permission");
});

test("does not fire twice for the same wait", () => {
  const st = createDetectState();
  detectNotifications(st, [waiting()], CFG, 1000);
  detectNotifications(st, [waiting()], CFG, 7000);
  expect(detectNotifications(st, [waiting()], CFG, 9000)).toEqual([]);
});

test("a new attention event re-arms the notification", () => {
  const st = createDetectState();
  detectNotifications(st, [waiting()], CFG, 1000);
  detectNotifications(st, [waiting()], CFG, 7000);
  detectNotifications(st, [waiting({ activity_ts: "t2" })], CFG, 8000);
  expect(detectNotifications(st, [waiting({ activity_ts: "t2" })], CFG, 20000).length).toBe(1);
});

test("leaving waiting cancels a pending notification", () => {
  const st = createDetectState();
  detectNotifications(st, [waiting()], CFG, 1000);
  detectNotifications(st, [mkRow({ session_id: "s1", status: "running" })], CFG, 2000);
  expect(detectNotifications(st, [mkRow({ session_id: "s1", status: "running" })], CFG, 9000)).toEqual([]);
});

test("a trigger not in the config never fires", () => {
  const st = createDetectState();
  const cfg: DetectConfig = { delayMs: 0, triggers: ["turn_end"] };
  detectNotifications(st, [waiting()], cfg, 1000);
  expect(detectNotifications(st, [waiting()], cfg, 9000)).toEqual([]);
});

test("session end fires immediately regardless of delay", () => {
  const st = createDetectState();
  const ended = mkRow({ session_id: "s1", status: "ended", exit_code: 0, activity_ts: "t9" });
  expect(detectNotifications(st, [ended], CFG, 1000).map((e) => e.trigger)).toEqual(["session_end"]);
});

test("delayMs=0 fires on the first observation", () => {
  const st = createDetectState();
  expect(detectNotifications(st, [waiting()], { ...CFG, delayMs: 0 }, 1000).length).toBe(1);
});

// === Tests for the three fixes ===

test("fired is bounded by live sessions, not notification count", () => {
  const st = createDetectState();
  // Simulate 100 activity updates across 5 concurrent sessions
  for (let tick = 0; tick < 100; tick++) {
    const rows = [];
    for (let s = 0; s < 5; s++) {
      const row = mkRow({
        session_id: `s${s}`,
        status: "waiting",
        last_input_kind: "permission",
        activity_ts: `t${tick}-${s}`, // unique per tick and session
      });
      rows.push(row);
    }
    detectNotifications(st, rows, { ...CFG, delayMs: 0 }, 1000 + tick);
  }
  // All 5 sessions are still live and each fired once with latest activity_ts
  // fired.size should be 5, not 100 (which would happen with Set-based dedup)
  expect(st.fired.size).toBe(5);
});

test("trigger flip within same activity_ts does not re-fire", () => {
  const st = createDetectState();
  // Fire with "permission"
  const prompt1 = detectNotifications(
    st,
    [mkRow({ session_id: "s1", status: "waiting", last_input_kind: "permission", activity_ts: "t1" })],
    { ...CFG, delayMs: 0 },
    1000
  );
  expect(prompt1.length).toBe(1);

  // Same activity_ts but different trigger (permission → prompt)
  // should NOT fire because the episode (activity_ts) is the same
  const prompt2 = detectNotifications(
    st,
    [mkRow({ session_id: "s1", status: "waiting", last_input_kind: "prompt", activity_ts: "t1" })],
    { ...CFG, delayMs: 0 },
    1001
  );
  expect(prompt2).toEqual([]);
});

test("null activity_ts: leaving and returning fires again", () => {
  const st = createDetectState();
  // Fire with null activity_ts
  const first = detectNotifications(
    st,
    [mkRow({ session_id: "s1", status: "waiting", last_input_kind: "permission", activity_ts: null })],
    { ...CFG, delayMs: 0 },
    1000
  );
  expect(first.length).toBe(1);

  // Session goes running (not eligible)
  detectNotifications(st, [mkRow({ session_id: "s1", status: "running" })], CFG, 1001);

  // Session returns to waiting with same null activity_ts
  // Since it left waiting, fired entry for s1 should be pruned
  // So this should fire again
  const second = detectNotifications(
    st,
    [mkRow({ session_id: "s1", status: "waiting", last_input_kind: "permission", activity_ts: null })],
    { ...CFG, delayMs: 0 },
    1002
  );
  expect(second.length).toBe(1);
});

test("continuously waiting with unchanged activity_ts fires exactly once", () => {
  const st = createDetectState();
  // Fire on first observation
  const first = detectNotifications(
    st,
    [mkRow({ session_id: "s1", status: "waiting", last_input_kind: "permission", activity_ts: "t1" })],
    { ...CFG, delayMs: 0 },
    1000
  );
  expect(first.length).toBe(1);

  // Many subsequent ticks with same state
  for (let i = 1001; i <= 1010; i++) {
    const result = detectNotifications(
      st,
      [mkRow({ session_id: "s1", status: "waiting", last_input_kind: "permission", activity_ts: "t1" })],
      { ...CFG, delayMs: 0 },
      i
    );
    expect(result).toEqual([]);
  }
});
