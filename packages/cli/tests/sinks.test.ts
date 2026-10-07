import { test, expect } from "bun:test";
import { dispatchNotification, isPaneVisible, type SinkDeps } from "../src/sinks.ts";
import { loadAttentionConfig } from "../src/attention-config.ts";
import type { SessionRow } from "@agmux/protocol";

// Local row factory: packages/tui/tests/helpers/mk-row.ts is out of this
// package's tsconfig root, and per-package `tsc --noEmit` rejects a relative
// cross-package import even though Bun would resolve it at runtime. See
// task-12-brief.md note 3 — do not widen tsconfig to make that import work.
function mkRow(over: Partial<SessionRow> = {}): SessionRow {
  return {
    session_id: "agx-000000001", agent_kind: "claude", profile: null, native_session_id: null,
    command: "claude", args: [], env_overrides: {}, cwd: "/tmp", pid: 1,
    tmux_session: null, tmux_window: null, tmux_socket: null, tmux_pane: null, host: "h", project: null,
    parent_session_id: null, start_ts: "2026-06-20T10:00:00.000Z", last_heartbeat_ts: null,
    end_ts: null, exit_code: null, signal: null, status: "running", origin: "native",
    turn_count: null, last_tool: null, last_tool_detail: null, last_input_kind: null,
    activity_ts: null, ...over,
  };
}

const CFG = loadAttentionConfig("").notify;

function deps(over: Partial<SinkDeps> = {}): SinkDeps & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    run: async (cmd, args) => { calls.push([cmd, ...args]); return 0; },
    capture: async () => "",
    which: () => true,
    log: () => {},
    warned: new Set<string>(),
    ...over,
  } as SinkDeps & { calls: string[][] };
}

const ev = { session_id: "agx-1", trigger: "permission" as const, row: mkRow({ session_id: "agx-1", tmux_session: "work", tmux_window: "2", tmux_pane: "%3" }) };

test("the body identifies the session by pane, so two agents in one window are distinguishable", async () => {
  const d = deps();
  const other = { session_id: "agx-2", trigger: "permission" as const,
    row: mkRow({ session_id: "agx-2", tmux_session: "work", tmux_window: "2", tmux_pane: "%9" }) };
  await dispatchNotification(ev, CFG, d);
  await dispatchNotification(other, CFG, d);
  const bodies = d.calls.map((c) => c.join(" ")).filter((c) => c.includes("needs permission"));
  expect(bodies.length).toBeGreaterThan(0);
  for (const b of bodies) expect(b).not.toContain("work:2");
  expect(bodies.some((b) => b.includes("work:%3"))).toBe(true);
  expect(bodies.some((b) => b.includes("work:%9"))).toBe(true);
});

test("falls back to the session name alone when the pane is unknown", async () => {
  const d = deps();
  await dispatchNotification(
    { session_id: "agx-3", trigger: "permission" as const,
      row: mkRow({ session_id: "agx-3", tmux_session: "work", tmux_pane: null }) },
    CFG, d,
  );
  const body = d.calls.map((c) => c.join(" ")).find((c) => c.includes("needs permission"))!;
  expect(body).toContain("work needs permission");
  expect(body).not.toContain("work:");
});

test("fires both the tmux toast and the OS notifier", async () => {
  const d = deps();
  await dispatchNotification(ev, CFG, d);
  const cmds = d.calls.map((c) => c[0]);
  expect(cmds).toContain("tmux");
  expect(cmds).toContain("terminal-notifier");
});

test("uses display-message, never display-popup", async () => {
  const d = deps();
  await dispatchNotification(ev, CFG, d);
  const tmuxCall = d.calls.find((c) => c[0] === "tmux")!;
  expect(tmuxCall).toContain("display-message");
  expect(tmuxCall.join(" ")).not.toContain("popup");
});

test("a visible pane suppresses the tmux toast but NOT the OS notification", async () => {
  const d = deps({ capture: async () => "%3\n" });
  await dispatchNotification(ev, CFG, d);
  const cmds = d.calls.map((c) => c[0]);
  expect(cmds).not.toContain("tmux");
  expect(cmds).toContain("terminal-notifier");
});

test("sound disabled omits the sound argument", async () => {
  const d = deps();
  await dispatchNotification(ev, { ...CFG, sound: false }, d);
  const call = d.calls.find((c) => c[0] === "terminal-notifier")!;
  expect(call).not.toContain("-sound");
});

test("a per-trigger sound override wins over the global sound name", async () => {
  const d = deps();
  await dispatchNotification(ev, { ...CFG, sounds: { permission: "Sosumi" } }, d);
  const call = d.calls.find((c) => c[0] === "terminal-notifier")!;
  expect(call).toContain("Sosumi");
});

test("no notifier available logs once and does not throw", async () => {
  const d = deps({ which: () => false });
  await dispatchNotification(ev, CFG, d);
  expect(d.calls.map((c) => c[0])).not.toContain("terminal-notifier");
});

test("an unresolvable notifier logs exactly once across many dispatches, and a fresh deps object logs again", async () => {
  const logs: string[] = [];
  const d = deps({ which: () => false, log: (s) => logs.push(s) });
  for (let i = 0; i < 1000; i++) await dispatchNotification(ev, CFG, d);
  expect(logs.length).toBe(1);
  expect(d.calls.map((c) => c[0])).not.toContain("terminal-notifier");

  // A second, independently constructed deps object (its own fresh `warned`
  // Set) must log again — proving the dedup state is per-caller, not global.
  // This is the regression fence for the module-level-Set order-dependence
  // bug the reviewer found.
  const logs2: string[] = [];
  const d2 = deps({ which: () => false, log: (s) => logs2.push(s) });
  await dispatchNotification(ev, CFG, d2);
  expect(logs2.length).toBe(1);
});

test("a resolved notifier whose run always rejects logs exactly once across many dispatches, and never throws", async () => {
  const logs: string[] = [];
  const d = deps({
    log: (s) => logs.push(s),
    run: async (cmd) => {
      if (cmd === "terminal-notifier") throw new Error("boom");
      return 0;
    },
  });
  for (let i = 0; i < 1000; i++) {
    await expect(dispatchNotification(ev, CFG, d)).resolves.toBeUndefined();
  }
  const failureLogs = logs.filter((s) => s.includes("terminal-notifier failed"));
  expect(failureLogs.length).toBe(1);
});

test("isPaneVisible compares the active pane of every attached client", async () => {
  expect(await isPaneVisible("%3", { capture: async () => "%1\n%3\n" } as any)).toBe(true);
  expect(await isPaneVisible("%9", { capture: async () => "%1\n%3\n" } as any)).toBe(false);
  expect(await isPaneVisible(null, { capture: async () => "%1\n" } as any)).toBe(false);
});
