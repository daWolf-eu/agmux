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
