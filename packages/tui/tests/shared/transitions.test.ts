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
