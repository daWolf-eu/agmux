import { isShellSafeId, shellSafeIdChars, stripControls, type SessionRow } from "@agmux/protocol";
import { statusGlyph, statusTone, toneGlyph, STATUS_COLORS, type StatusTone } from "./glyph.ts";
import { MOCHA } from "./palette.ts";
import { abbreviateBranch, clip, COLUMNS, type ColumnStyle } from "./columns.ts";

// Which sessions get a chip. "attention" = waiting or done: everything that
// wants you; "working" adds what is still running. Rows are open sessions only,
// so "all" adds idle on top.
export type ShowMode = "working" | "all" | "attention" | "done" | "waiting";

export const SHOW_TONES: Record<ShowMode, StatusTone[]> = {
  working: ["waiting", "done", "running"],
  all: ["waiting", "done", "running", "idle"],
  attention: ["waiting", "done"],
  done: ["done"],
  waiting: ["waiting"],
};

// What the filter chip steps through, wrapping around. `done` stays a config
// value but is not on the cycle; from there the cycle starts over.
export const SHOW_CYCLE: ShowMode[] = ["working", "all", "attention", "waiting"];

export function nextShow(mode: ShowMode, step: 1 | -1 = 1): ShowMode {
  const i = SHOW_CYCLE.indexOf(mode);
  if (i < 0) return SHOW_CYCLE[0]!;
  return SHOW_CYCLE[(i + step + SHOW_CYCLE.length) % SHOW_CYCLE.length]!;
}

export interface StatusLineOpts {
  show: ShowMode;
  max: number;
  format: string;
  /** Abbreviation budget for {tmux_session}. */
  sessionWidth?: number;
  /** Cells the line may take (see fitLine); unset = no limit. */
  width?: number;
  /** Templates and colours; unset keys keep DEFAULT_STYLE. */
  style?: Partial<StatusLineStyle>;
}

// The tones a status line can show (rows are open sessions only).
export type LineTone = "waiting" | "done" | "running" | "idle";
export const LINE_TONES: LineTone[] = ["waiting", "done", "running", "idle"];

// How the line looks, as tmux style templates. `{name}` placeholders are filled
// in; a `#{…}` tmux format is left alone. Click ranges wrap each chip on top,
// so a template never deals with them.
//   chip      {color} status colour, {body} the `format` rendering (fields in
//             their colour roles), or any `format` field ({glyph}, {name}, …)
//             as plain text for a template that styles them itself
//   overflow  {count} sessions beyond `max`
//   filter    {glyphs} the shown statuses' glyphs, each in its colour; {mode}
//   separator between chips
//   colors    per status, for {color}, {body} and {glyphs}
export interface StatusLineStyle {
  chip: string;
  overflow: string;
  filter: string;
  separator: string;
  colors: Partial<Record<LineTone, string>>;
}

// The dash's selected-row look: a `▌` bar in the status colour on the surface0
// highlight, the body after it, one cell of padding at the end.
export const DEFAULT_STYLE: StatusLineStyle = {
  chip: `#[bg=${MOCHA.surface0},fg={color}]▌{body} #[default]`,
  overflow: `#[bg=${MOCHA.surface0},fg=${MOCHA.overlay0}] +{count} #[default]`,
  filter: `#[bg=${MOCHA.surface0},fg=${MOCHA.overlay1}] ▽ {glyphs} #[default]`,
  separator: " ",
  colors: {},
};

// Click targets. Every chip is a tmux `range=user|X` whose X starts with
// CHIP_MARK, so agmux.tmux can tell our clicks from the window list and any
// user ranges (`#{m:@*,#{mouse_status_range}}`) and hand everything else to the
// binding it replaced. FILTER_TOKEN is the filter chip. tmux caps X at 15
// bytes: the mark plus a 14-char id prefix. Session ids are UUIDv7, whose first
// 13 chars are the full 48-bit ms timestamp, so the prefix only collides for
// two sessions minted in the same millisecond (the click then reports an
// ambiguous prefix). agmux.tmux single-quotes the token inside run-shell, so it
// keeps only hex digits and dashes: a replicated id must never carry shell syntax
// (ingest already enforces UUIDs; local ids are UUIDv7 and pass unchanged).
export const CHIP_MARK = "@";
export const FILTER_TOKEN = `${CHIP_MARK}filter`;
const RANGE_MAX = 15;

export function chipToken(sessionId: string): string {
  return CHIP_MARK + shellSafeIdChars(sessionId).slice(0, RANGE_MAX - CHIP_MARK.length);
}

export type ChipTarget = { kind: "filter" } | { kind: "session"; prefix: string };

// The inverse of chipToken / FILTER_TOKEN; null for anything that isn't ours.
export function parseChipToken(token: string): ChipTarget | null {
  if (token === FILTER_TOKEN) return { kind: "filter" };
  if (!token.startsWith(CHIP_MARK) || token.length === CHIP_MARK.length) return null;
  const prefix = token.slice(CHIP_MARK.length);
  return isShellSafeId(prefix) ? { kind: "session", prefix } : null;
}

// Middle-truncate: a numeric or branch-like suffix is the discriminating part,
// so dropping the middle keeps far more signal than a trailing ellipsis would.
export function abbreviate(s: string, max: number): string {
  if (s.length <= max) return s;
  if (max <= 1) return "…";
  const head = Math.ceil((max - 1) / 2);
  const tail = max - 1 - head;
  return s.slice(0, head) + "…" + (tail > 0 ? s.slice(s.length - tail) : "");
}

function visible(rows: SessionRow[], show: ShowMode): SessionRow[] {
  if (show === "all") return rows;
  const tones = SHOW_TONES[show];
  return rows.filter((r) => tones.includes(statusTone(r)));
}

function shortId(id: string): string {
  return id.length <= 8 ? id : id.slice(-8);
}

// A chip is a few cells of a status bar shared with the window list: names and
// branches get a tighter cap than the dash's columns. A line over its width
// budget shrinks names down to NAME_MIN before it hides any chip.
const NAME_MAX = 24;
export const NAME_MIN = 9;
const BRANCH_MAX = 20;

// Per-field caps for one render.
interface Caps { session: number; name: number }

// Same colour roles as the dash columns (SessionTable.cellColor): hue only for
// the state and the branch accent, the neutral ramp for everything else. Unlike
// the dash the name is not bold: no other column competes with it, and bold
// costs width in some fonts.
const FIELD_STYLE: Record<string, ColumnStyle> = {
  glyph: "state", name: "state", status: "state",
  branch: "accent",
  agent_kind: "sub", last_tool: "sub",
};

// Remote chips: `⇄ ` before the name, `? ` while the sync is stale (as hostLabel).
function remotePrefix(r: SessionRow): string {
  if (!r.remote) return "";
  return r.sync_stale ? "? " : "⇄ ";
}

// Field text is untrusted (remote rows): no control characters reach tmux.
function fieldValue(r: SessionRow, key: string, caps: Caps): string {
  return stripControls(rawFieldValue(r, key, caps));
}

function rawFieldValue(r: SessionRow, key: string, caps: Caps): string {
  switch (key) {
    case "glyph": return statusGlyph(r).glyph;
    case "name": return remotePrefix(r) + clip(COLUMNS.name.text(r, 0), caps.name);
    case "repo": return r.git_repo ?? "";
    case "branch": return r.git_branch ? abbreviateBranch(r.git_branch, BRANCH_MAX) : "";
    case "tmux_session": return r.tmux_session ? abbreviate(r.tmux_session, caps.session) : "";
    case "tmux_window": return r.tmux_window ?? "";
    case "tmux_pane": return r.tmux_pane ?? "";
    case "project": return r.project ?? "";
    case "agent_kind": return r.agent_kind;
    case "status": return r.status;
    case "session_id": return shortId(r.session_id);
    case "last_tool": return r.last_tool ?? "";
    default: return "";
  }
}

function fieldStyle(key: string, state: string): string {
  switch (FIELD_STYLE[key] ?? "faint") {
    case "state": return `#[fg=${state}]`;
    case "accent": return `#[fg=${MOCHA.pink}]`;
    case "sub": return `#[fg=${MOCHA.subtext0}]`;
    default: return `#[fg=${MOCHA.overlay0}]`;
  }
}

// Agent-reported text reaches tmux, which format-expands the cache it reads via
// `#(cat …)`: `#[` would open a style, `#{…}` expand a format, `#(…)` run a
// command. `##` is tmux's literal `#`, so doubling every `#` neutralises all three.
function escapeStyles(s: string): string {
  return s.replace(/#/g, "##");
}

// Substitute placeholders, collapsing separators only when their field is empty.
// A separator is dropped only when ITS placeholder is empty; data is never rewritten.
// "{a}:{b}" with b empty renders "a", never "a:". A project name like "foo/" is preserved.
// Literal text between placeholders is drawn faint; each field in its role colour.
function renderFormat(r: SessionRow, format: string, caps: Caps, state: string): string {
  const faint = `#[fg=${MOCHA.overlay0}]`;
  const out: string[] = [];
  let last = 0;
  for (const m of format.matchAll(/([:\/]?)\{(\w+)\}/g)) {
    const lit = format.slice(last, m.index).replace(/\s+/g, " ");
    if (lit) out.push(faint + lit);
    last = m.index + m[0].length;
    const v = fieldValue(r, m[2]!, caps);
    if (!v) continue;
    if (m[1]) out.push(faint + m[1]);
    out.push(fieldStyle(m[2]!, state) + escapeStyles(v));
  }
  const tail = format.slice(last).replace(/\s+/g, " ");
  if (tail) out.push(faint + tail);
  return collapseSpaces(out);
}

// Empty fields leave their surrounding literals behind: squeeze runs of spaces
// across segments and drop leading/trailing ones, styles untouched.
function collapseSpaces(segs: string[]): string {
  let s = segs.join("");
  s = s.replace(/ ((?:#\[[^\]]*\])*) /g, "$1 ");
  s = s.replace(/^((?:#\[[^\]]*\])*) +/, "$1");
  s = s.replace(/ +((?:#\[[^\]]*\])*)$/, "$1");
  return s;
}

// Fill `{key}` placeholders; `#{…}` belongs to tmux and is skipped.
function fill(template: string, value: (key: string) => string): string {
  return template.replace(/(?<!#)\{(\w+)\}/g, (_m, key: string) => value(key));
}

function toneColor(tone: StatusTone, style: StatusLineStyle): string {
  return (style.colors as Partial<Record<StatusTone, string>>)[tone] ?? STATUS_COLORS[tone];
}

function chip(r: SessionRow, format: string, caps: Caps, style: StatusLineStyle): string {
  const color = toneColor(statusTone(r), style);
  const body = fill(style.chip, (key) => {
    if (key === "color") return color;
    if (key === "body") return renderFormat(r, format, caps, color);
    return escapeStyles(fieldValue(r, key, caps));
  });
  return `#[range=user|${chipToken(r.session_id)}]${body}#[norange]`;
}

function filterChip(show: ShowMode, style: StatusLineStyle): string {
  const glyphs = SHOW_TONES[show].map((t) => `#[fg=${toneColor(t, style)}]${toneGlyph(t)}`).join("");
  const body = fill(style.filter, (key) => (key === "glyphs" ? glyphs : key === "mode" ? show : ""));
  return `#[range=user|${FILTER_TOKEN}]${body}#[norange]`;
}

// The cells tmux draws for a status format: `#[…]` styles take none, `##` is
// one literal `#`. A `#{…}` left for tmux is counted as written (an estimate).
export function statusWidth(s: string): number {
  return Bun.stringWidth(s.replace(/##|#\[[^\]]*\]/g, (m) => (m === "##" ? "#" : "")));
}

export function formatStatusLine(rows: SessionRow[], opts: StatusLineOpts): string {
  const session = opts.sessionWidth ?? 12;
  const style: StatusLineStyle = { ...DEFAULT_STYLE, ...opts.style };
  const shown = visible(rows, opts.show);
  const count = Math.min(shown.length, Math.max(0, opts.max));

  const line = (name: number, n: number): string => {
    const parts = shown.slice(0, n).map((r) => chip(r, opts.format, { session, name }, style));
    const overflow = shown.length - n;
    if (overflow > 0) parts.push(fill(style.overflow, (key) => (key === "count" ? String(overflow) : "")));
    // Always there, even when the filter hides every session: it is the way back.
    parts.push(filterChip(opts.show, style));
    return parts.join(style.separator);
  };
  return opts.width === undefined ? line(NAME_MAX, count) : fitLine(line, count, opts.width);
}

// A status bar clips what doesn't fit from the end, and the filter chip is last.
// So within `width`: first every name shrinks by the same cap, one cell at a
// time down to NAME_MIN; only then do chips fold into the +N, last ones first.
// Width 0 still gets the filter chip — tmux clips it, nothing to do about that.
function fitLine(line: (name: number, n: number) => string, count: number, width: number): string {
  for (let name = NAME_MAX; name >= NAME_MIN; name--) {
    const s = line(name, count);
    if (statusWidth(s) <= width) return s;
  }
  for (let n = count - 1; n > 0; n--) {
    const s = line(NAME_MIN, n);
    if (statusWidth(s) <= width) return s;
  }
  return line(NAME_MIN, 0);
}
