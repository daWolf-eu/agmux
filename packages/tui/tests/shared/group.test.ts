import { test, expect } from "bun:test";
import { inGroup, groupRows, nextGroup, initialGroup, GROUPS } from "../../src/shared/group.ts";
import { mkRow } from "../helpers/mk-row.ts";

test("inGroup: open matches live, closed matches terminal, all matches everything", () => {
  const running = mkRow({ status: "running" });
  const ended = mkRow({ status: "ended" });
  expect(inGroup(running, "open")).toBe(true);
  expect(inGroup(ended, "open")).toBe(false);
  expect(inGroup(ended, "closed")).toBe(true);
  expect(inGroup(running, "closed")).toBe(false);
  expect(inGroup(running, "all")).toBe(true);
  expect(inGroup(ended, "all")).toBe(true);
});

test("groupRows keeps only rows in the group", () => {
  const rows = [mkRow({ session_id: "a", status: "running" }), mkRow({ session_id: "b", status: "lost" })];
  expect(groupRows(rows, "open").map((r) => r.session_id)).toEqual(["a"]);
  expect(groupRows(rows, "closed").map((r) => r.session_id)).toEqual(["b"]);
  expect(groupRows(rows, "all").map((r) => r.session_id)).toEqual(["a", "b"]);
});

test("nextGroup cycles open -> closed -> all -> open", () => {
  expect(nextGroup("open")).toBe("closed");
  expect(nextGroup("closed")).toBe("all");
  expect(nextGroup("all")).toBe("open");
  expect(GROUPS).toEqual(["open", "closed", "all"]);
});

test("initialGroup derives the starting group from a status string", () => {
  expect(initialGroup(undefined)).toBe("open");
  expect(initialGroup("open")).toBe("open");
  expect(initialGroup("active")).toBe("open");
  expect(initialGroup("closed")).toBe("closed");
  expect(initialGroup("ended,lost")).toBe("closed");
  expect(initialGroup("idle,running")).toBe("open");
  expect(initialGroup("running,ended")).toBe("all"); // mixed live+terminal
  expect(initialGroup("nonsense")).toBe("all");      // unparseable -> all
});
