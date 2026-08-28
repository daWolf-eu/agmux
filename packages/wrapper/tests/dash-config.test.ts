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

test("parses [dash] limit and the per-group [dash.<group>] tables", () => {
  expect(
    parseDashSection({
      limit: 25,
      open: { limit: 40, interval: 0.5 },
      closed: { limit: 2000 },
      all: { interval: 30 },
    }),
  ).toEqual({
    limit: 25,
    groups: {
      open: { limit: 40, interval: 0.5 },
      closed: { limit: 2000 },
      all: { interval: 30 },
    },
  });
});

test("rejects bad group tables", () => {
  expect(() => parseDashSection({ limit: 0 })).toThrow(/\[dash\] limit must be/);
  expect(() => parseDashSection({ open: { limit: 1.5 } })).toThrow(/\[dash\.open\] limit must be/);
  expect(() => parseDashSection({ closed: { interval: -1 } })).toThrow(/\[dash\.closed\] interval must be/);
  expect(() => parseDashSection({ all: { preview: "mirror" } })).toThrow(/\[dash\.all\] unknown key/);
  expect(() => parseDashSection({ open: 5 })).toThrow(/\[dash\.open\] must be a table/);
});
