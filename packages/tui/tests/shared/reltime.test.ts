import { test, expect } from "bun:test";
import { relTime } from "../../src/shared/reltime.ts";

const NOW = Date.parse("2026-06-20T12:00:00.000Z");

test("seconds", () => { expect(relTime("2026-06-20T11:59:57.000Z", NOW)).toBe("3s"); });
test("clamps negative (clock skew) to 0s", () => { expect(relTime("2026-06-20T12:00:05.000Z", NOW)).toBe("0s"); });
test("minutes", () => { expect(relTime("2026-06-20T11:50:00.000Z", NOW)).toBe("10m"); });
test("hours", () => { expect(relTime("2026-06-20T09:00:00.000Z", NOW)).toBe("3h"); });
test("yesterday at exactly 1 day", () => { expect(relTime("2026-06-19T12:00:00.000Z", NOW)).toBe("yesterday"); });
test("days under a week", () => { expect(relTime("2026-06-17T12:00:00.000Z", NOW)).toBe("3d"); });
test("falls back to YYYY-MM-DD beyond a week", () => { expect(relTime("2026-06-02T12:00:00.000Z", NOW)).toBe("2026-06-02"); });
test("invalid input → dash", () => { expect(relTime("not-a-date", NOW)).toBe("-"); });
