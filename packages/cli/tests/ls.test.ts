import { test, expect } from "bun:test";
import type { SessionRow } from "@agmux/protocol";
import { buildLsQuery, formatTable } from "../src/ls.ts";

function mkRow(sid: string, start: string): SessionRow {
  return {
    session_id: sid, agent_kind: "claude", profile: null, native_session_id: null,
    command: "claude", args: [], env_overrides: {}, cwd: "/tmp", pid: 1,
    tmux_session: null, tmux_window: null, tmux_pane: null, host: "h", project: null,
    parent_session_id: null, start_ts: start, last_heartbeat_ts: null, end_ts: null,
    exit_code: null, signal: null, status: "running", origin: "native", turn_count: null,
  };
}

test("buildLsQuery maps resolved opts to hub params", () => {
  const qs = buildLsQuery({
    limit: 5, sort: "activity", asc: true, reverse: true,
    status: "open", agent: "claude", profile: "work",
  });
  expect(qs.get("limit")).toBe("5");
  expect(qs.get("sort")).toBe("activity");
  expect(qs.get("order")).toBe("asc");
  expect(qs.get("status")).toBe("open");
  expect(qs.get("agent_kind")).toBe("claude");
  expect(qs.get("profile")).toBe("work");
});

test("buildLsQuery omits absent filters and maps desc", () => {
  const qs = buildLsQuery({ limit: 50, sort: "started", asc: false, reverse: false });
  expect(qs.get("order")).toBe("desc");
  expect(qs.get("status")).toBeNull();
  expect(qs.get("agent_kind")).toBeNull();
  expect(qs.get("profile")).toBeNull();
});

test("formatTable: reverse flips data rows but keeps the header on top", () => {
  const rows = [mkRow("aaaa", "2026-06-10T11:00:00.000Z"), mkRow("bbbb", "2026-06-10T10:00:00.000Z")];
  const plain = formatTable(rows, false);
  expect(plain[0]).toStartWith("ID");
  expect(plain[1]).toStartWith("aaaa");
  expect(plain[2]).toStartWith("bbbb");
  const flipped = formatTable(rows, true);
  expect(flipped[0]).toStartWith("ID");
  expect(flipped[1]).toStartWith("bbbb");
  expect(flipped[2]).toStartWith("aaaa");
});
