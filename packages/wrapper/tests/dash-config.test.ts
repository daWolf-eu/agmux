import { test, expect } from "bun:test";
import { parseDashSection } from "../src/profile.ts";

test("empty/undefined section yields {}", () => {
  expect(parseDashSection(undefined)).toEqual({});
  expect(parseDashSection({})).toEqual({});
});

test("valid fields parse", () => {
  expect(parseDashSection({ preview: "mirror", interval: 2, status: "active", sort: "activity" }))
    .toEqual({ preview: "mirror", interval: 2, status: "active", sort: "activity" });
});

test("invalid preview throws", () => {
  expect(() => parseDashSection({ preview: "nope" })).toThrow(/preview must be/);
});

test("invalid interval throws", () => {
  expect(() => parseDashSection({ interval: 0 })).toThrow(/interval must be/);
});

test("invalid status throws", () => {
  expect(() => parseDashSection({ status: "bogus" })).toThrow(/status must be/);
});

test("null section throws", () => {
  expect(() => parseDashSection(null)).toThrow(/must be a table/);
});

test("invalid sort throws", () => {
  expect(() => parseDashSection({ sort: "bogus" })).toThrow(/sort must be/);
});
