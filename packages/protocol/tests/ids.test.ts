import { test, expect } from "bun:test";
import { mintSessionId } from "../src/ids.ts";

test("mintSessionId returns a v7 UUID string, unique per call", () => {
  const a = mintSessionId();
  const b = mintSessionId();
  expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(a).not.toBe(b);
});
