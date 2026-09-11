import { test, expect } from "bun:test";
import { loadAttentionConfig, parseDuration } from "../src/attention-config.ts";

test("empty config yields documented defaults", () => {
  const c = loadAttentionConfig("");
  expect(c.notify.enabled).toBe(true);
  expect(c.notify.delayMs).toBe(5000);
  expect(c.notify.soundName).toBe("Ping");
  expect(c.notify.command).toBe("auto");
  expect(c.statusline.show).toBe("all");
  expect(c.statusline.max).toBe(6);
  expect(c.statusline.position).toBe("status2");
  expect(c.statusline.format).toBe("{glyph} {tmux_session}:{tmux_window}");
});

test("parses durations in both forms", () => {
  expect(parseDuration("5s")).toBe(5000);
  expect(parseDuration("2m")).toBe(120000);
  expect(parseDuration(30)).toBe(30000);
  expect(parseDuration("0")).toBe(0);
});

test("an unparseable duration throws rather than silently disabling the debounce", () => {
  expect(() => parseDuration("soon")).toThrow(/duration/i);
  expect(() => loadAttentionConfig(`[notify]\ndelay = "soon"\n`)).toThrow(/duration/i);
});

test("overrides replace defaults", () => {
  const c = loadAttentionConfig(`
[notify]
delay = "20s"
triggers = ["permission"]
sound = false

[notify.sounds]
permission = "Sosumi"

[statusline]
show = "unread"
max = 3
position = "status-right"
`);
  expect(c.notify.delayMs).toBe(20000);
  expect(c.notify.triggers).toEqual(["permission"]);
  expect(c.notify.sound).toBe(false);
  expect(c.notify.sounds.permission).toBe("Sosumi");
  expect(c.statusline.show).toBe("unread");
  expect(c.statusline.max).toBe(3);
  expect(c.statusline.position).toBe("status-right");
});

test("an unknown trigger or show mode is rejected by name", () => {
  expect(() => loadAttentionConfig(`[notify]\ntriggers = ["explode"]\n`)).toThrow(/explode/);
  expect(() => loadAttentionConfig(`[statusline]\nshow = "sideways"\n`)).toThrow(/sideways/);
});

test("statusline.max validates and throws on invalid values", () => {
  expect(loadAttentionConfig("").statusline.max).toBe(6);
  expect(loadAttentionConfig(`[statusline]\nmax = 3\n`).statusline.max).toBe(3);
  expect(() => loadAttentionConfig(`[statusline]\nmax = "three"\n`)).toThrow(/three/);
  expect(() => loadAttentionConfig(`[statusline]\nmax = 0\n`)).toThrow(/0/);
  expect(() => loadAttentionConfig(`[statusline]\nmax = -1\n`)).toThrow(/-1/);
  expect(() => loadAttentionConfig(`[statusline]\nmax = 2.5\n`)).toThrow(/2.5/);
});
