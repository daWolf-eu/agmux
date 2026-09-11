import { test, expect } from "bun:test";
import { validateKnownPayload } from "../src/validators.ts";

test("accepts a well-formed session.seen payload", () => {
  expect(validateKnownPayload("session.seen", { source: "attach" }).ok).toBe(true);
  expect(validateKnownPayload("session.seen", { source: "dismiss" }).ok).toBe(true);
});

test("rejects an unknown source", () => {
  expect(validateKnownPayload("session.seen", { source: "telepathy" }).ok).toBe(false);
});

test("rejects a missing source", () => {
  expect(validateKnownPayload("session.seen", {}).ok).toBe(false);
});
