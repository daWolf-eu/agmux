import { test, expect } from "bun:test";
import { validateKnownPayload, EVENT_KINDS_ADAPTER } from "../src/index.ts";

const git = { branch: "main", repo: "agmux", remote: "git@github.com:o/agmux.git", root: "/src/agmux" };

test("session.metadata is an adapter event kind", () => {
  expect(EVENT_KINDS_ADAPTER).toContain("session.metadata");
});

test("session.metadata: both groups optional; git may be null", () => {
  expect(validateKnownPayload("session.metadata", {}).ok).toBe(true);
  expect(validateKnownPayload("session.metadata", { git }).ok).toBe(true);
  expect(validateKnownPayload("session.metadata", { git: null }).ok).toBe(true);
  expect(validateKnownPayload("session.metadata", { git: { ...git, branch: null, remote: null, repo: null } }).ok).toBe(true);
  expect(validateKnownPayload("session.metadata", { name: { name: "Fix tests", source: "agent" } }).ok).toBe(true);
});

test("session.metadata: rejects malformed groups", () => {
  expect(validateKnownPayload("session.metadata", { git: { branch: "main" } }).ok).toBe(false);
  expect(validateKnownPayload("session.metadata", { git: { ...git, branch: 3 } }).ok).toBe(false);
  expect(validateKnownPayload("session.metadata", { name: { name: "", source: "user" } }).ok).toBe(false);
  expect(validateKnownPayload("session.metadata", { name: { name: "x", source: "terminal" } }).ok).toBe(false);
  expect(validateKnownPayload("session.metadata", { name: "x" }).ok).toBe(false);
});
