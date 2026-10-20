import { test, expect } from "bun:test";
import { hostDetail } from "../../src/opentui/PreviewPane.tsx";
import { mkRow } from "../helpers/mk-row.ts";

const NOW = Date.parse("2026-06-20T12:00:00.000Z");
const SYNC = "2026-06-20T11:56:00.000Z";

test("hostDetail: local is just the host", () => {
  expect(hostDetail(mkRow({ host: "mac" }), NOW)).toBe("mac");
});
test("hostDetail: remote with last sync", () => {
  expect(hostDetail(mkRow({ remote: true, host: "os/sbx", last_sync_ts: SYNC }), NOW)).toBe("os/sbx · last sync 4m ago");
});
test("hostDetail: remote without last sync omits it", () => {
  expect(hostDetail(mkRow({ remote: true, host: "os/sbx", last_sync_ts: null }), NOW)).toBe("os/sbx");
});
test("hostDetail: stale", () => {
  expect(hostDetail(mkRow({ remote: true, host: "os/sbx", last_sync_ts: SYNC, sync_stale: true }), NOW))
    .toBe("os/sbx · last sync 4m ago · stale");
  expect(hostDetail(mkRow({ remote: true, host: "os/sbx", last_sync_ts: null, sync_stale: true }), NOW)).toBe("os/sbx · stale");
});
test("hostDetail: no ago after yesterday", () => {
  expect(hostDetail(mkRow({ remote: true, host: "os/sbx", last_sync_ts: "2026-06-19T09:00:00.000Z" }), NOW))
    .toBe("os/sbx · last sync yesterday");
});
