import { test, expect } from "bun:test";
import { normalizeClaude } from "../src/adapters/claude/normalize.ts";

const base = {
  point: "session.registered" as const,
  source: "hook-command" as const,
  cursor: null,
  target: { agentKind: "claude" as const, profile: null },
  raw: { session_id: "inner-123", cwd: "/tmp" },
};

test("claim present + env/stdin mismatch → dropped (wrapped guard holds)", () => {
  const out = normalizeClaude({
    ...base,
    env: { AGMUX_SESSION_ID: "claimed", CLAUDE_CODE_SESSION_ID: "outer-999" },
  });
  expect(out.events).toHaveLength(0);
});

test("no claim + env/stdin mismatch → passes (direct sub-agent tracked)", () => {
  const out = normalizeClaude({
    ...base,
    env: { CLAUDE_CODE_SESSION_ID: "outer-999" }, // no AGMUX_SESSION_ID
  });
  expect(out.events).toHaveLength(1);
  expect(out.events[0]!.payload).toMatchObject({ native_session_id: "inner-123" });
});

test("claim present + env matches stdin → passes", () => {
  const out = normalizeClaude({
    ...base,
    env: { AGMUX_SESSION_ID: "claimed", CLAUDE_CODE_SESSION_ID: "inner-123" },
  });
  expect(out.events).toHaveLength(1);
});

test("session.registered captures CLAUDE_CONFIG_DIR into env_overrides", () => {
  const out = normalizeClaude({
    point: "session.registered", source: "hook-command",
    raw: { session_id: "n-1", cwd: "/work" },
    target: { agentKind: "claude", profile: null },
    env: { CLAUDE_CONFIG_DIR: "/Users/u/.claude-chax", SECRET_TOKEN: "shhh" },
  } as any);
  expect(out.events).toHaveLength(1);
  const p = out.events[0]!.payload as any;
  expect(p.env_overrides).toEqual({ CLAUDE_CONFIG_DIR: "/Users/u/.claude-chax" });
  expect(p.env_overrides.SECRET_TOKEN).toBeUndefined();
});

test("session.registered with no config dir yields empty env_overrides", () => {
  const out = normalizeClaude({
    point: "session.registered", source: "hook-command",
    raw: { session_id: "n-2", cwd: "/work" },
    target: { agentKind: "claude", profile: null },
    env: {},
  } as any);
  expect((out.events[0]!.payload as any).env_overrides).toEqual({});
});

// --- attention signals --------------------------------------------------------

const at = (point: any, raw: Record<string, unknown>) =>
  normalizeClaude({ ...base, point, raw: { session_id: "s", ...raw }, env: {} }).events;

test("PreToolUse → tool.started carrying the tool", () => {
  expect(at("tool.started", { tool_name: "Bash" })).toEqual([{ kind: "tool.started", payload: { tool: "Bash" } }]);
});

test("PreToolUse of AskUserQuestion → input.required{question}", () => {
  expect(at("tool.started", { tool_name: "AskUserQuestion" }))
    .toEqual([{ kind: "input.required", payload: { kind: "question" } }]);
});

test("PostToolUse of AskUserQuestion also reports the answer (input.received)", () => {
  expect(at("tool.used", { tool_name: "AskUserQuestion" }).map((e) => e.kind)).toEqual(["tool.used", "input.received"]);
  expect(at("tool.used", { tool_name: "Bash" }).map((e) => e.kind)).toEqual(["tool.used"]);
});

test("Stop that keeps working (tool_use / background tasks) is not a turn end", () => {
  expect(at("turn.ended", { stop_reason: "tool_use" })).toEqual([]);
  expect(at("turn.ended", { background_tasks: true })).toEqual([]);
  expect(at("turn.ended", { background_tasks: [{ id: "b1" }] })).toEqual([]);
  expect(at("turn.ended", { stop_reason: "end_turn", background_tasks: false }).map((e) => e.kind)).toEqual(["turn.ended"]);
  expect(at("turn.ended", { background_tasks: [] }).map((e) => e.kind)).toEqual(["turn.ended"]);
});
