/** @jsxImportSource @opentui/react */
import { MOCHA } from "../shared/palette.ts";

// `[key] label` — the one keybinding style (footer, help, yank). Brackets are
// near-invisible chrome, the key reads brighter than its label. `keyWidth` pads
// the bracketed key so labels line up in a grid; `labelWidth` pads the label.
export function KeyHint(props: { k: string; label: string; lead?: string; keyWidth?: number; labelWidth?: number }) {
  const keyPad = " ".repeat(Math.max(0, (props.keyWidth ?? 0) - props.k.length - 2));
  const label = props.labelWidth ? props.label.padEnd(props.labelWidth) : props.label;
  return (
    <span>
      <span fg={MOCHA.surface2}>{`${props.lead ?? ""}[`}</span>
      <span fg={MOCHA.subtext0}>{props.k}</span>
      <span fg={MOCHA.surface2}>]</span>
      <span fg={MOCHA.overlay0}>{`${keyPad} ${label}`}</span>
    </span>
  );
}
