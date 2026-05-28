import { test, expect, beforeEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Store } from "@agmux/store";
import { drainQueueDir } from "../src/drain.ts";

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agmux-drain-")); });

const ev = {
  event_id: "01HZ7P0K8WVQH8WGS8X9DC9F2P",
  ts: "2026-05-28T12:00:00.000Z",
  session_id: "0190a3e0-0000-7000-8000-000000000000",
  kind: "session.started", version: 1, host: "macbook.local",
  payload: { agent_kind: "claude", profile: "p", command: "ccc",
    args: [], env_overrides: {}, cwd: "/tmp", pid: 1,
    tmux_session: null, tmux_window: null, tmux_pane: null, project: null },
};

test("drainQueueDir ingests every line and deletes the file", () => {
  const f = path.join(tmp, `${ev.session_id}.jsonl`);
  fs.writeFileSync(f, JSON.stringify(ev) + "\n");
  const store = Store.openInMemory();
  const r = drainQueueDir(tmp, store);
  expect(r.filesDrained).toBe(1);
  expect(r.eventsIngested).toBe(1);
  expect(fs.existsSync(f)).toBe(false);
  expect(store.listEvents()).toHaveLength(1);
});

test("drainQueueDir is robust to malformed lines (skips them, keeps draining)", () => {
  const f = path.join(tmp, `${ev.session_id}.jsonl`);
  fs.writeFileSync(f, "not json\n" + JSON.stringify(ev) + "\n");
  const store = Store.openInMemory();
  const r = drainQueueDir(tmp, store);
  expect(r.eventsIngested).toBe(1);
  expect(r.linesSkipped).toBe(1);
});

test("drainQueueDir on missing directory is a no-op", () => {
  const store = Store.openInMemory();
  const r = drainQueueDir(path.join(tmp, "nope"), store);
  expect(r.filesDrained).toBe(0);
});
