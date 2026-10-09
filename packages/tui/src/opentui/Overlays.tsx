/** @jsxImportSource @opentui/react */
import type { ReactNode } from "react";
import { TextAttributes } from "@opentui/core";
import type { SessionRow } from "@agmux/protocol";
import { STATUS_COLORS, TONES, statusGlyph, toneGlyph, type StatusTone } from "../shared/glyph.ts";
import { MOCHA } from "../shared/palette.ts";
import { clip } from "../shared/columns.ts";
import type { YankField } from "../shared/yank.ts";
import type { AttachTarget } from "../shared/attach-targets.ts";
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
  ["/", "search"], ["⏎", "attach/resume"], ["A", "attach to…"], ["tab", "preview tab"],
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

// --- pickers (yank, attach) --------------------------------------------------

const PICKER_MAX_WIDTH = 96;

interface PickerItem { key: string; label: string; value: string; dim: boolean }

// A digit-keyed list for the selected session: "▌ 1   Label   value". Dim items
// keep their slot; their value shows dimmed ("—" when empty).
function PickerOverlay(props: {
  title: string; row: SessionRow; items: PickerItem[]; cursor: number; screenWidth: number; hints: ReactNode;
}) {
  const { row, items, cursor, title } = props;
  const g = statusGlyph(row);
  const lw = Math.max(...items.map((f) => f.label.length));
  // "▌ 1   Label   value": bar(2) + digit(1) + 3 + label + 3 + value
  const prefix = 2 + 1 + 3 + lw + 3;
  const longest = Math.max(...items.map((f) => Math.max(f.dim ? 1 : 0, f.value.length)));
  const width = Math.max(40, Math.min(PICKER_MAX_WIDTH, props.screenWidth - 4, prefix + longest));
  const valueW = width - prefix;
  return (
    <Centered width={width}>
      <text wrapMode="none">
        <span fg={MOCHA.text} attributes={TextAttributes.BOLD}>{title}</span>
        <span fg={g.color} attributes={TextAttributes.BOLD}>{`   ${clip(row.name || row.session_id, width - title.length - 3)}`}</span>
      </text>
      <Blank />
      {items.map((f, i) => {
        const sel = i === cursor;
        const dim = f.dim;
        return (
          <box key={i} style={{ backgroundColor: sel ? MOCHA.surface0 : undefined }}>
            <text wrapMode="none">
              <span fg={g.color}>{sel ? "▌ " : "  "}</span>
              <span fg={dim ? MOCHA.surface2 : MOCHA.subtext0}>{f.key}</span>
              <span fg={dim ? MOCHA.surface2 : sel ? MOCHA.subtext1 : MOCHA.overlay1}>{`   ${f.label.padEnd(lw)}   `}</span>
              <span fg={dim ? MOCHA.surface2 : sel ? MOCHA.text : MOCHA.subtext0}>
                {(dim ? (f.value || "—") : clip(f.value, valueW)).padEnd(valueW)}
              </span>
            </text>
          </box>
        );
      })}
      <Blank />
      <text wrapMode="none">{props.hints}</text>
    </Centered>
  );
}

export function YankOverlay(props: { row: SessionRow; fields: YankField[]; cursor: number; screenWidth: number }) {
  const items = props.fields.map((f, i) => ({ key: i === 9 ? "0" : String(i + 1), label: f.label, value: f.value, dim: f.empty }));
  return (
    <PickerOverlay
      title="yank field" row={props.row} items={items} cursor={props.cursor} screenWidth={props.screenWidth}
      hints={<>
        <KeyHint k="1-0/⏎" label="copy" />
        <KeyHint k="j/k" label="move" lead="  " />
        <KeyHint k="esc" label="close" lead="  " />
      </>}
    />
  );
}

export function AttachOverlay(props: { row: SessionRow; targets: AttachTarget[]; cursor: number; screenWidth: number }) {
  const items = props.targets.map((t, i) => ({ key: String(i + 1), label: t.label, value: t.enabled ? "" : t.reason, dim: !t.enabled }));
  return (
    <PickerOverlay
      title="attach to" row={props.row} items={items} cursor={props.cursor} screenWidth={props.screenWidth}
      hints={<>
        <KeyHint k={`1-${items.length}/⏎`} label="open" />
        <KeyHint k="j/k" label="move" lead="  " />
        <KeyHint k="esc" label="close" lead="  " />
      </>}
    />
  );
}
