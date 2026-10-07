import type { SessionRow } from "@agmux/protocol";
import { statusGlyph } from "./glyph.ts";

// "attention" = waiting or done: everything that wants you.
export type ShowMode = "all" | "attention" | "done" | "waiting";

export interface StatusLineOpts {
  show: ShowMode;
  max: number;
  format: string;
  /** Abbreviation budget for {tmux_session}. */
  sessionWidth?: number;
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
  if (show === "waiting") return rows.filter((r) => r.status === "waiting");
  if (show === "done") return rows.filter((r) => r.status === "done");
  if (show === "attention") return rows.filter((r) => r.status === "waiting" || r.status === "done");
  return rows;
}

function shortId(id: string): string {
  return id.length <= 8 ? id : id.slice(-8);
}

function fieldValue(r: SessionRow, key: string, sessionWidth: number): string {
  switch (key) {
    case "glyph": return statusGlyph(r).glyph;
    case "tmux_session": return r.tmux_session ? abbreviate(r.tmux_session, sessionWidth) : "";
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

// Substitute placeholders, collapsing separators only when their field is empty.
// A separator is dropped only when ITS placeholder is empty; data is never rewritten.
// "{a}:{b}" with b empty renders "a", never "a:". A project name like "foo/" is preserved.
function renderFormat(r: SessionRow, format: string, sessionWidth: number): string {
  return format
    .replace(/([:\/]?)\{(\w+)\}/g, (_m, sep: string, key: string) => {
      const v = fieldValue(r, key, sessionWidth);
      return v ? sep + v : "";
    })
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function formatStatusLine(rows: SessionRow[], opts: StatusLineOpts): string {
  const sessionWidth = opts.sessionWidth ?? 12;
  const shown = visible(rows, opts.show);
  const head = shown.slice(0, Math.max(0, opts.max));
  const overflow = shown.length - head.length;

  const parts = head.map((r) => {
    const { color } = statusGlyph(r);
    const body = renderFormat(r, opts.format, sessionWidth);
    return `#[range=user|${r.session_id}]#[fg=${color}]${body}#[default]#[norange]`;
  });
  if (overflow > 0) parts.push(`#[fg=#6c7086]+${overflow}#[default]`);
  return parts.join("  ");
}
