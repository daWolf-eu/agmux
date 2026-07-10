import { test, expect } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import type { SessionRow } from "@agmux/protocol";
import type { SessionFeed } from "../src/feed.ts";
import { WatchApp } from "../src/watch-app.tsx";

function mkRow(sid: string): SessionRow {
  return {
    session_id: sid, agent_kind: "claude", profile: null, native_session_id: null,
    command: "claude", args: [], env_overrides: {}, cwd: "/tmp", pid: 1,
    tmux_session: null, tmux_window: null, tmux_socket: null, tmux_pane: null, host: "h", project: null,
    parent_session_id: null, start_ts: "2026-06-11T10:00:00.000Z", last_heartbeat_ts: null,
    end_ts: null, exit_code: null, signal: null, status: "running", origin: "native",
    turn_count: 1, last_tool: "Edit", last_tool_detail: "a.ts", last_input_kind: null,
    activity_ts: null,
  };
}

// A feed the test drives by hand.
function manualFeed() {
  let update: (rows: SessionRow[]) => void = () => {};
  let error: (e: Error) => void = () => {};
  let unsubscribed = false;
  const feed: SessionFeed = {
    subscribe(onUpdate, onError) {
      update = onUpdate; error = onError;
      return () => { unsubscribed = true; };
    },
  };
  return { feed, push: (r: SessionRow[]) => update(r), fail: (e: Error) => error(e),
           wasUnsubscribed: () => unsubscribed };
}

// DEVIATION from plan: tests await Bun.sleep(0) after each push/fail. Under
// real ink 7 + React 19, a setState driven from an external (non-input)
// callback commits on the next microtask, so lastFrame() only reflects it
// after a yield. Component semantics are unchanged.
test("renders connecting state, then the table on first update", async () => {
  const m = manualFeed();
  const { lastFrame } = render(
    <WatchApp feed={m.feed} reverse={false} hubUrl="http://h" clock={() => "12:00:00"} />,
  );
  expect(lastFrame()).toContain("connecting to http://h");
  m.push([mkRow("aaaa")]);
  await Bun.sleep(0);
  expect(lastFrame()).toContain("tool: Edit a.ts");
  expect(lastFrame()).toContain("1 sessions · refreshed 12:00:00 · q to quit");
});

test("feed error keeps the last table and shows reconnecting in the footer", async () => {
  const m = manualFeed();
  const { lastFrame } = render(
    <WatchApp feed={m.feed} reverse={false} hubUrl="http://h" clock={() => "12:00:00"} />,
  );
  m.push([mkRow("aaaa")]);
  await Bun.sleep(0);
  m.fail(new Error("ECONNREFUSED"));
  await Bun.sleep(0);
  expect(lastFrame()).toContain("aaaa");             // table retained
  expect(lastFrame()).toContain("reconnecting");
  m.push([mkRow("bbbb")]);                            // recovery clears the error
  await Bun.sleep(0);
  expect(lastFrame()).not.toContain("reconnecting");
});

test("q exits and unsubscribes the feed", async () => {
  const m = manualFeed();
  const { stdin, unmount } = render(
    <WatchApp feed={m.feed} reverse={false} hubUrl="http://h" clock={() => "12:00:00"} />,
  );
  m.push([mkRow("aaaa")]);
  stdin.write("q");
  await Bun.sleep(0); // let ink process exit + effect cleanup
  expect(m.wasUnsubscribed()).toBe(true);
  unmount();
});
