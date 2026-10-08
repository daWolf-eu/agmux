/** @jsxImportSource @opentui/react */
import { MOCHA } from "../shared/palette.ts";

// The everyday keys only; the full list (incl. g/G, x kill, u mark read) is in `?`.
// `drop`: when the line doesn't fit, hints go lowest first (absent = always shown).
const HINTS: { key: string; label: string; drop?: number }[] = [
  { key: "j/k", label: "move", drop: 6 },
  { key: "s", label: "sort" },
  { key: "f", label: "filter", drop: 3 },
  { key: "/", label: "search", drop: 5 },
  { key: "⏎", label: "attach" },
  { key: "y", label: "yank", drop: 4 },
  { key: "tab", label: "preview", drop: 2 },
  { key: "p", label: "panel", drop: 1 },
  { key: "?", label: "help" },
  { key: "q", label: "quit" },
];
const HINT_GAP = 2;

function hintWidth(h: (typeof HINTS)[number], sortLabel: string): number {
  return `[${h.key}] ${h.label}`.length + (h.key === "s" ? sortLabel.length + 1 : 0);
}

export function fitHints(width: number, sortLabel: string): typeof HINTS {
  let shown = HINTS;
  const total = (hs: typeof HINTS) => hs.reduce((sum, h) => sum + hintWidth(h, sortLabel), 0) + HINT_GAP * (hs.length - 1);
  const droppable = HINTS.filter((h) => h.drop !== undefined).sort((a, b) => a.drop! - b.drop!);
  for (const d of droppable) {
    if (total(shown) <= width) break;
    shown = shown.filter((h) => h !== d);
  }
  return shown;
}

export function FooterBar(props: {
  error: string | null; searching: boolean; search: string; confirmKill: string | null; notice: string | null;
  // Active sort, e.g. "status▾" — shown after the `s` hint, since the header row
  // (which also marks it) is off by default.
  sortLabel: string;
  width: number;
}) {
  if (props.confirmKill) return <text fg={MOCHA.red}>kill {props.confirmKill}? y/n</text>;
  if (props.searching) return <text>search: {props.search}▏</text>;
  if (props.notice) return <text fg={MOCHA.yellow}>{props.notice}</text>;
  if (props.error) return <text fg={MOCHA.red}>hub unreachable — reconnecting… ({props.error})</text>;
  return (
    <text wrapMode="none">
      {fitHints(props.width, props.sortLabel).map(({ key, label }, i) => (
        <span key={key}>
          <span fg={MOCHA.surface2}>{`${i > 0 ? "  " : ""}[`}</span>
          <span fg={MOCHA.subtext0}>{key}</span>
          <span fg={MOCHA.surface2}>]</span>
          <span fg={MOCHA.overlay0}>{` ${label}`}</span>
          {key === "s" && <span fg={MOCHA.overlay1}>{` ${props.sortLabel}`}</span>}
        </span>
      ))}
    </text>
  );
}
