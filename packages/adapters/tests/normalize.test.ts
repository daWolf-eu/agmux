import { test, expect } from "bun:test";
import { stampEvents } from "../src/core/normalize.ts";
import type { CanonicalEvent } from "../src/core/types.ts";

const events: CanonicalEvent[] = [
  { kind: "turn.started", payload: { turn_id: "t1" } },
  { kind: "usage.reported", payload: { cumulative: false, source: "transcript-delta", input_tokens: 5 }, dedup_key: "k:1" },
];

test("stampEvents fills the envelope, preserves kind/payload/dedup_key", () => {
  let i = 0;
  const out = stampEvents(events, {
    sessionId: "0190a3e0-0000-7000-8000-000000000000",
    host: "h",
    now: () => "2026-05-29T10:00:00.000Z",
    newId: () => `id-${i++}`,
  });
  expect(out).toHaveLength(2);
  expect(out[0]).toEqual({
    event_id: "id-0", ts: "2026-05-29T10:00:00.000Z",
    session_id: "0190a3e0-0000-7000-8000-000000000000",
    kind: "turn.started", version: 1, host: "h",
    payload: { turn_id: "t1" }, dedup_key: null,
  });
  expect(out[1]!.dedup_key).toBe("k:1");
});

test("stampEvents defaults to real ulid + iso timestamp without injection", () => {
  const out = stampEvents([{ kind: "tool.used", payload: { tool: "bash" } }], { sessionId: "s", host: "h" });
  expect(out[0]!.event_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/); // ULID (Crockford base32)
  expect(out[0]!.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
});
