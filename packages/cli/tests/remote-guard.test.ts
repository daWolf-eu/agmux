import { test, expect } from "bun:test";
import { remoteRefusal } from "../src/remote-guard.ts";

const base = { session_id: "019f1898-8e0f-7000-ab55-07d09f673b59", host: "sbx-1" };

test("remoteRefusal: null for local rows", () => {
  expect(remoteRefusal({ ...base }, "kill")).toBeNull();
  expect(remoteRefusal({ ...base, remote: false }, "attach")).toBeNull();
});

test("remoteRefusal: exact message for remote rows", () => {
  expect(remoteRefusal({ ...base, remote: true }, "resume")).toBe(
    "resume: 019f1898 runs on sbx-1; remote resume is not supported yet",
  );
});
