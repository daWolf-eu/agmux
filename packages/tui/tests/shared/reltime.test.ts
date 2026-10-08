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

test("ageColor fades at 1m / 1h / 1d / 1w", async () => {
  const { ageColor } = await import("../../src/shared/reltime.ts");
  const { MOCHA } = await import("../../src/shared/palette.ts");
  const at = (ms: number) => new Date(NOW - ms).toISOString();
  const colors = [at(59_000), at(60_000), at(3_600_000), at(86_400_000), at(7 * 86_400_000)].map((t) => ageColor(t, NOW));
  expect(colors).toEqual([MOCHA.lavender, MOCHA.text, MOCHA.overlay1, MOCHA.surface2, MOCHA.surface1]);
});
