# AGENTS.md — `@agmux/tui`

`agmux ls` table formatting, `agmux watch` (Ink), `agmux dash` (OpenTUI) and the tmux status-line renderer. Pure logic lives in `src/shared/` (unit-tested), OpenTUI components in `src/opentui/` (render-tested via `@opentui/react/test-utils`).

## Look & feel rules (dash)

- **Hue = meaning only.** Status colours come from `STATUS_COLORS` (`shared/glyph.ts`); everything else (chrome, secondary columns, legend) uses the neutral ramp in `MOCHA` (`shared/palette.ts`). Sole exception: the branch column (`accent` role, pink). Never hard-code hexes in components — pick a `MOCHA` token.
- **Whitespace over lines.** No pane borders or titles; blank spacer rows around the body; one faint `│` between table and preview. Overlays (`Overlays.tsx`: help, yank) are borderless blocks centred on an empty screen.
- **Keys** render through `KeyHint` (`[key] label`) everywhere — footer, help, yank.
- **One glyph vocabulary** shared by dash and the tmux status line: `statusTone()` → `toneGlyph(tone, frame)` / `STATUS_COLORS`. Red is reserved for errors; `waiting` is yellow.
- Height budget in `DashApp`: header + spacer + footer spacer + footer = 4 rows; `PreviewPane.viewportHeight` must stay explicit (flex alone lets the scrollbox push the footer off-screen).
- Rows are one `<text>` of `<span>`s each (sibling `<text>` flex items trim boundary spaces and break alignment). Use `wrapMode="none"`.

## Table columns (`shared/columns.ts`)

`COLUMNS` is the registry; `[dash] columns` (validated in `cli/src/parse-dash.ts` against `COLUMN_KEYS`) picks and orders them, default `DEFAULT_COLUMNS`. Sorting (`shared/sort.ts`) cycles through the visible columns; last-seen newest-first is always the tie-break.

### Adding a column

1. Add the key to `COLUMN_KEYS` and a `ColDef` to `COLUMNS`: `header`, `align`, `style` (`state` | `faint` | `accent` | `sub` | `age` — a colour *role*, mapped to hexes in `SessionTable.cellColor`), `text(row, now)` (return `""` for missing, not `-`), optional `max` (hard cap) and `min` (shrink floor), and `shorten(text, width)` when a plain tail ellipsis loses the useful part (see `abbreviateBranch`).
2. If it may give way when the pane is narrow, add it to `SHRINK_ORDER` (earlier = squeezed first; `name` last).
3. Non-text sort semantics (numeric, rank) go in `sort.ts` `primary()` and `sortDirection()`; text columns sort a→z with blanks last for free.
4. Document it in the README `[dash] columns` list; extend `tests/shared/columns.test.ts`.

**Deferred:** a format-string column spec with per-column styling (e.g. `"{glyph} {name:bold} {repo:faint}"`). The `style` role on `ColDef` is the hook it would override.
