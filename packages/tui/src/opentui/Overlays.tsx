/** @jsxImportSource @opentui/react */
import type { ReactNode } from "react";
import { TextAttributes } from "@opentui/core";
import type { SessionRow } from "@agmux/protocol";
import { STATUS_COLORS, TONES, statusGlyph, toneGlyph, type StatusTone } from "../shared/glyph.ts";
import { MOCHA } from "../shared/palette.ts";
import { clip } from "../shared/columns.ts";
import type { YankField } from "../shared/yank.ts";
import { KeyHint } from "./KeyHint.tsx";

// Full-screen overlays: no border, the content block centred on an empty screen.
// `width` is the block's own width, so a highlighted row spans it evenly.
function Centered(props: { width: number; children: ReactNode }) {
  return (
    <box style={{ width: "100%", height: "100%", alignItems: "center", justifyContent: "center" }}>
      <box style={{ flexDirection: "column", width: props.width }}>{props.children}</box>
    </box>
  );
}

function Heading(props: { children: ReactNode }) {
  return <text fg={MOCHA.text} attributes={TextAttributes.BOLD}>{props.children}</text>;
}

const Blank = () => <text> </text>;

// --- help --------------------------------------------------------------------

// The full key list (the footer shows only the everyday ones), in the help's wording.
const HELP_KEYS: [string, string][] = [
  ["j/k", "move"], ["g/G", "top/bottom"], ["s", "sort"], ["f", "filter"],
  ["/", "search"], ["⏎", "attach/resume"], ["tab", "preview tab"],
  ["p", "show/hide preview"], ["y", "yank field"], ["x", "kill"],
  ["u", "mark read"], ["?", "help"], ["q", "quit"],
];

const TONE_MEANING: Record<StatusTone, string> = {
  waiting: "needs you: a permission, a question, input",
  done: "finished, not seen yet",
  running: "working",
  idle: "seen, or nothing happened yet",
  closed: "ended or lost",
  error: "ended non-zero or on a signal",
};

const KEY_W = Math.max(...HELP_KEYS.map(([k]) => k.length + 2));
const LABEL_W = Math.max(...HELP_KEYS.map(([, l]) => l.length));
const KEY_ROWS = Math.ceil(HELP_KEYS.length / 2);
const COL_GAP = "     ";
const TONE_W = Math.max(...TONES.map((t) => t.length));
const HELP_WIDTH = Math.max(
  (KEY_W + 1 + LABEL_W) * 2 + COL_GAP.length,
  2 + TONE_W + 3 + Math.max(...Object.values(TONE_MEANING).map((m) => m.length)),
);

export function HelpOverlay(props: { frame: number }) {
  return (
    <Centered width={HELP_WIDTH}>
      <Heading>keys</Heading>
      <Blank />
      {Array.from({ length: KEY_ROWS }, (_, row) => {
        const left = HELP_KEYS[row]!;
        const right = HELP_KEYS[row + KEY_ROWS];
        return (
          <text key={row} wrapMode="none">
            <KeyHint k={left[0]} label={left[1]} keyWidth={KEY_W} labelWidth={LABEL_W} />
            {right && <KeyHint k={right[0]} label={right[1]} keyWidth={KEY_W} lead={COL_GAP} />}
          </text>
        );
      })}
      <Blank />
      <Heading>status</Heading>
      <Blank />
      {TONES.map((tone) => (
        <text key={tone} wrapMode="none">
          <span fg={STATUS_COLORS[tone]} attributes={tone === "waiting" ? TextAttributes.BOLD : undefined}>
            {`${toneGlyph(tone, props.frame)} ${tone.padEnd(TONE_W)}`}
          </span>
          <span fg={MOCHA.overlay0}>{`   ${TONE_MEANING[tone]}`}</span>
        </text>
      ))}
      <Blank />
      <text><KeyHint k="?/esc" label="close" /></text>
    </Centered>
  );
}

// --- yank --------------------------------------------------------------------

const YANK_MAX_WIDTH = 96;

export function YankOverlay(props: { row: SessionRow; fields: YankField[]; cursor: number; screenWidth: number }) {
  const { row, fields, cursor } = props;
  const g = statusGlyph(row);
  const lw = Math.max(...fields.map((f) => f.label.length));
  // "▌ 1   Label   value": bar(2) + digit(1) + 3 + label + 3 + value
  const prefix = 2 + 1 + 3 + lw + 3;
  const longest = Math.max(...fields.map((f) => (f.empty ? 1 : f.value.length)));
  const width = Math.max(40, Math.min(YANK_MAX_WIDTH, props.screenWidth - 4, prefix + longest));
  const valueW = width - prefix;
  const digit = (i: number) => (i === 9 ? "0" : String(i + 1));
  return (
    <Centered width={width}>
      <text wrapMode="none">
        <span fg={MOCHA.text} attributes={TextAttributes.BOLD}>yank field</span>
        <span fg={g.color} attributes={TextAttributes.BOLD}>{`   ${clip(row.name || row.session_id, width - 13)}`}</span>
      </text>
      <Blank />
      {fields.map((f, i) => {
        const sel = i === cursor;
        const dim = f.empty;
        return (
          <box key={i} style={{ backgroundColor: sel ? MOCHA.surface0 : undefined }}>
            <text wrapMode="none">
              <span fg={g.color}>{sel ? "▌ " : "  "}</span>
              <span fg={dim ? MOCHA.surface2 : MOCHA.subtext0}>{digit(i)}</span>
              <span fg={dim ? MOCHA.surface2 : sel ? MOCHA.subtext1 : MOCHA.overlay1}>{`   ${f.label.padEnd(lw)}   `}</span>
              <span fg={dim ? MOCHA.surface2 : sel ? MOCHA.text : MOCHA.subtext0}>
                {(dim ? "—" : clip(f.value, valueW)).padEnd(valueW)}
              </span>
            </text>
          </box>
        );
      })}
      <Blank />
      <text wrapMode="none">
        <KeyHint k="1-0/⏎" label="copy" />
        <KeyHint k="j/k" label="move" lead="  " />
        <KeyHint k="esc" label="close" lead="  " />
      </text>
    </Centered>
  );
}
