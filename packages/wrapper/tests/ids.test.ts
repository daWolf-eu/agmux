import { test, expect } from "bun:test";
import { mintSessionId, mintEventId } from "../src/ids.ts";

test("mintSessionId returns a UUIDv7", () => {
  const id = mintSessionId();
  expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("mintEventId returns a 26-char ULID", () => {
  const id = mintEventId();
  expect(id).toHaveLength(26);
  expect(id).toMatch(/^[0-9A-Z]{26}$/);
});
