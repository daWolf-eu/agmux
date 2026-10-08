import { test, expect } from "bun:test";
import { loadAttentionConfig } from "../src/attention-config.ts";
import { readTmuxStyle, resolveLineStyle, TMUX_STYLE_OPTIONS } from "../src/statusline-style.ts";

test("config.toml [statusline] templates and [statusline.colors] parse, unset keys stay unset", () => {
  const c = loadAttentionConfig(`
[statusline]
chip = "#[fg={color}]{name}"
separator = ""
[statusline.colors]
waiting = "#ff0000"
`);
  expect(c.statusline.style).toEqual({ chip: "#[fg={color}]{name}", separator: "", colors: { waiting: "#ff0000" } });
  expect(loadAttentionConfig("").statusline.style).toEqual({});
});

test("an unknown status in [statusline.colors] is a config error", () => {
  expect(() => loadAttentionConfig(`[statusline.colors]\nlost = "red"`)).toThrow(/statusline.colors key/);
});

test("inline is a valid position", () => {
  expect(loadAttentionConfig(`[statusline]\nposition = "inline"`).statusline.position).toBe("inline");
});

test("readTmuxStyle asks tmux for every option in one display -p and keeps the set ones", async () => {
  let args: string[] = [];
  const keys = Object.keys(TMUX_STYLE_OPTIONS);
  const values = keys.map((k) => (k === "chip" ? "#[fg={color}]{name}" : k === "color_done" ? "green" : ""));
  const style = await readTmuxStyle(async (_cmd, a) => { args = a; return values.join("\x1f") + "\n"; });
  expect(args[0]).toBe("display-message");
  expect(args[2]).toContain("#{@agmux-statusline-chip}");
  expect(style).toEqual({ chip: "#[fg={color}]{name}", color_done: "green" });
});

test("readTmuxStyle is empty when tmux isn't there", async () => {
  expect(await readTmuxStyle(async () => { throw new Error("no server"); })).toEqual({});
});

test("tmux options override config.toml key by key", () => {
  const cfg = loadAttentionConfig(`
[statusline]
format = "{glyph} {name}"
chip = "toml-chip"
filter = "toml-filter"
[statusline.colors]
waiting = "toml-yellow"
done = "toml-green"
`).statusline;
  const { format, style } = resolveLineStyle(cfg, { format: "{name}", chip: "tmux-chip", color_done: "tmux-green" });
  expect(format).toBe("{name}");
  expect(style.chip).toBe("tmux-chip");
  expect(style.filter).toBe("toml-filter");
  expect(style.colors).toEqual({ waiting: "toml-yellow", done: "tmux-green" });
});
