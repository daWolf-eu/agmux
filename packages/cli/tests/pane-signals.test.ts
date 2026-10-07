import { test, expect } from "bun:test";
import type { SessionRow } from "@agmux/protocol";
import { collectPaneSignals, createPaneSignalState } from "../src/pane-signals.ts";

function row(over: Partial<SessionRow>): SessionRow {
  return {
    session_id: "s1", agent_kind: "claude", profile: null, native_session_id: null, command: "claude",
    args: [], env_overrides: {}, cwd: "/", pid: 1, tmux_session: "w", tmux_window: "@1", tmux_pane: "%1",
    tmux_socket: null, host: "h", project: null, parent_session_id: null, start_ts: "t", last_heartbeat_ts: null,
    end_ts: null, exit_code: null, signal: null, status: "running", origin: "native", ...over,
  };
}

function tmux(titles: Record<string, string>, clients: string[]) {
  const calls: string[][] = [];
  const capture = async (_cmd: string, args: string[]) => {
    calls.push(args);
    if (args.includes("list-panes")) return Object.entries(titles).map(([p, t]) => `${p}\t${t}`).join("\n");
    if (args.includes("list-clients")) return clients.join("\n");
    return "";
  };
  return { capture, calls };
}

const deps = (capture: any, now = 0) => ({ capture, host: "h", now: () => now, newId: () => "id" });

test("native session titles become title.changed, once per change", async () => {
  const st = createPaneSignalState();
  const t = tmux({ "%1": "⠂ task" }, []);
  const a = await collectPaneSignals(st, [row({})], deps(t.capture));
  expect(a.map((e) => [e.kind, e.payload])).toEqual([["title.changed", { title: "task", activity: "working" }]]);
  expect(await collectPaneSignals(st, [row({})], deps(t.capture, 500))).toEqual([]);
});

test("wrapper sessions are skipped (the wrapper reports its own titles)", async () => {
  const t = tmux({ "%1": "⠂ task" }, []);
  expect(await collectPaneSignals(createPaneSignalState(), [row({ origin: "wrapper" })], deps(t.capture))).toEqual([]);
});

test("a done session on a pane a FOCUSED client shows is marked seen, once per episode", async () => {
  const st = createPaneSignalState();
  const r = row({ status: "done", origin: "wrapper", attention_ts: "a1" });
  const t = tmux({}, ["attached,focused,UTF-8\t%1"]);
  const out = await collectPaneSignals(st, [r], deps(t.capture));
  expect(out.map((e) => [e.kind, e.session_id, e.payload])).toEqual([["session.seen", "s1", { source: "focus" }]]);
  expect(await collectPaneSignals(st, [r], deps(t.capture))).toEqual([]);
  expect((await collectPaneSignals(st, [{ ...r, attention_ts: "a2" }], deps(t.capture))).length).toBe(1);
});

test("an attached but unfocused client (terminal in the background) does not count", async () => {
  const t = tmux({}, ["attached,UTF-8\t%1"]);
  const r = row({ status: "done", origin: "wrapper", attention_ts: "a1" });
  expect(await collectPaneSignals(createPaneSignalState(), [r], deps(t.capture))).toEqual([]);
});

test("no done rows → tmux clients are not even queried; tmux failures are swallowed", async () => {
  const t = tmux({}, []);
  await collectPaneSignals(createPaneSignalState(), [row({ status: "idle", origin: "wrapper" })], deps(t.capture));
  expect(t.calls.some((a) => a.includes("list-clients"))).toBe(false);
  const boom = async () => { throw new Error("no tmux"); };
  expect(await collectPaneSignals(createPaneSignalState(), [row({ status: "done" })], deps(boom))).toEqual([]);
});

test("rows on a named socket query that tmux server", async () => {
  const t = tmux({ "%1": "✳ x" }, []);
  await collectPaneSignals(createPaneSignalState(), [row({ tmux_socket: "/tmp/sock" })], deps(t.capture));
  expect(t.calls[0]!.slice(0, 2)).toEqual(["-S", "/tmp/sock"]);
});
