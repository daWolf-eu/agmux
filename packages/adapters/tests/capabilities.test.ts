import { test, expect } from "bun:test";
import { buildAttachedEvent } from "../src/core/capabilities.ts";

test("buildAttachedEvent emits a session.adapter_attached canonical event", () => {
  const caps = { "turn.started": { fulfil: "yes", source: "hook-command", liveness: "live" } } as const;
  const ev = buildAttachedEvent({
    agentKind: "codex", profile: "work", adapterVersion: "3", capabilities: caps,
  });
  expect(ev.kind).toBe("session.adapter_attached");
  expect(ev.dedup_key).toBeNull();
  expect(ev.payload).toEqual({
    agent_kind: "codex", profile: "work", adapter_version: "3", capabilities: caps,
  });
});
