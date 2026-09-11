import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SessionRow } from "@agmux/protocol";
import { writeLineAtomic, runNotifyd, type NotifydDeps } from "../src/notifyd.ts";
import { heartbeatPath } from "../src/statusline-cache.ts";
import { loadAttentionConfig } from "../src/attention-config.ts";

test("writes via a temp file then renames, so a reader never sees a partial line", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agmux-sl-"));
  const target = path.join(dir, "nested", "statusline");
  const seen: string[] = [];
  writeLineAtomic(target, "hello", {
    mkdir: (d) => { seen.push(`mkdir:${d}`); fs.mkdirSync(d, { recursive: true }); },
    write: (f, t) => { seen.push(`write:${path.basename(f)}`); fs.writeFileSync(f, t); },
    rename: (a, b) => { seen.push("rename"); fs.renameSync(a, b); },
  });
  expect(seen[0]).toContain("mkdir:");
  expect(seen[1]).toContain("write:statusline.");   // temp sibling, not the target
  expect(seen[2]).toBe("rename");
  expect(fs.readFileSync(target, "utf8")).toBe("hello");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a write failure is swallowed — the daemon must not die over a cache file", () => {
  expect(() => writeLineAtomic("/nope/x", "hi", {
    mkdir: () => { throw new Error("EACCES"); },
    write: () => {}, rename: () => {},
  })).not.toThrow();
});

// --- runNotifyd -------------------------------------------------------

const row: SessionRow = {
  session_id: "agx-1", agent_kind: "claude", profile: null, native_session_id: null,
  command: "claude", args: [], env_overrides: {}, cwd: "/tmp", pid: 1,
  tmux_session: "work", tmux_window: "2", tmux_socket: null, tmux_pane: null,
  host: "h", project: null, parent_session_id: null, start_ts: "2026-09-11T10:00:00.000Z",
  last_heartbeat_ts: null, end_ts: null, exit_code: null, signal: null,
  status: "running", origin: "native",
};

function memFsDeps(): { fs: NonNullable<NotifydDeps["fs"]>; files: Record<string, string> } {
  const files: Record<string, string> = {};
  return {
    files,
    fs: {
      mkdir: () => {},
      write: (f, t) => { files[f] = t; },
      rename: (a, b) => { files[b] = files[a]!; delete files[a]; },
    },
  };
}

function baseDeps(over: Partial<NotifydDeps> = {}): NotifydDeps {
  return {
    env: { XDG_RUNTIME_DIR: "/run/u" },
    config: loadAttentionConfig(""),
    ...over,
  };
}

test("a feed update writes the rendered line and the heartbeat", async () => {
  const { fs: fsDeps, files } = memFsDeps();
  const ac = new AbortController();
  let capturedOnUpdate: ((rows: SessionRow[]) => void) | undefined;
  const unsubscribe = () => {};

  const p = runNotifyd(
    { hubUrl: "http://127.0.0.1:1", stop: ac.signal },
    baseDeps({
      fs: fsDeps,
      makeFeed: () => ({
        subscribe: (onUpdate) => { capturedOnUpdate = onUpdate; return unsubscribe; },
      }),
    }),
  );

  expect(capturedOnUpdate).toBeDefined();
  capturedOnUpdate!([row]);

  const cache = "/run/u/agmux/statusline";
  expect(files[cache]).toContain("work:2");
  expect(files[heartbeatPath(cache)]).toBeTruthy();

  ac.abort();
  expect(await p).toBe(0);
});

test("the feed's onError path writes the hub-down marker", async () => {
  const { fs: fsDeps, files } = memFsDeps();
  const ac = new AbortController();
  let capturedOnError: ((e: Error) => void) | undefined;

  const p = runNotifyd(
    { hubUrl: "http://127.0.0.1:1", stop: ac.signal },
    baseDeps({
      fs: fsDeps,
      makeFeed: () => ({
        subscribe: (_onUpdate, onError) => { capturedOnError = onError; return () => {}; },
      }),
    }),
  );

  expect(capturedOnError).toBeDefined();
  capturedOnError!(new Error("refused"));

  const cache = "/run/u/agmux/statusline";
  expect(files[cache]).toContain("hub down");
  expect(files[heartbeatPath(cache)]).toBeTruthy();

  ac.abort();
  expect(await p).toBe(0);
});

test("aborting the stop signal unsubscribes from the feed and resolves runNotifyd", async () => {
  const { fs: fsDeps } = memFsDeps();
  const ac = new AbortController();
  let unsubscribed = false;

  const p = runNotifyd(
    { hubUrl: "http://127.0.0.1:1", stop: ac.signal },
    baseDeps({
      fs: fsDeps,
      makeFeed: () => ({
        subscribe: () => () => { unsubscribed = true; },
      }),
    }),
  );

  expect(unsubscribed).toBe(false);
  ac.abort();
  const code = await p;
  expect(code).toBe(0);
  expect(unsubscribed).toBe(true);
});

test("shutdown removes the SIGINT/SIGTERM listeners it added", async () => {
  const { fs: fsDeps } = memFsDeps();
  const ac = new AbortController();

  const before = { sigint: process.listenerCount("SIGINT"), sigterm: process.listenerCount("SIGTERM") };

  const p = runNotifyd(
    { hubUrl: "http://127.0.0.1:1", stop: ac.signal },
    baseDeps({
      fs: fsDeps,
      makeFeed: () => ({ subscribe: () => () => {} }),
    }),
  );

  // The daemon registered its own SIGINT/SIGTERM handlers while awaiting shutdown.
  expect(process.listenerCount("SIGINT")).toBe(before.sigint + 1);
  expect(process.listenerCount("SIGTERM")).toBe(before.sigterm + 1);

  ac.abort();
  await p;

  expect(process.listenerCount("SIGINT")).toBe(before.sigint);
  expect(process.listenerCount("SIGTERM")).toBe(before.sigterm);
});
