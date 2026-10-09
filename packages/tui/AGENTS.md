# AGENTS.md — `@agmux/tui`

`agmux ls` table formatting, `agmux watch` (Ink), `agmux dash` (OpenTUI) and the tmux status-line renderer. Pure logic lives in `src/shared/` (unit-tested), OpenTUI components in `src/opentui/` (render-tested via `@opentui/react/test-utils`).

## Look & feel rules (dash)

- **Hue = meaning only.** Status colours come from `STATUS_COLORS` (`shared/glyph.ts`); everything else (chrome, secondary columns, legend) uses the neutral ramp in `MOCHA` (`shared/palette.ts`). Sole exception: the branch column (`accent` role, pink). Never hard-code hexes in components — pick a `MOCHA` token.
- **Whitespace over lines.** No pane borders or titles; blank spacer rows around the body; one faint `│` between table and preview. Overlays (`Overlays.tsx`: help, yank, attach — the two pickers share `PickerOverlay`) are borderless blocks centred on an empty screen.
- **Keys** render through `KeyHint` (`[key] label`) everywhere — footer, help, yank.
- **One glyph vocabulary** shared by dash and the tmux status line: `statusTone()` → `toneGlyph(tone, frame)` / `STATUS_COLORS`. Red is reserved for errors; `waiting` is yellow.
- Height budget in `DashApp`: header + spacer + footer spacer + footer = 4 rows; `PreviewPane.viewportHeight` must stay explicit (flex alone lets the scrollbox push the footer off-screen).
- Rows are one `<text>` of `<span>`s each (sibling `<text>` flex items trim boundary spaces and break alignment). Use `wrapMode="none"`.

## tmux status line (`shared/statusline.ts`)

- One chip per session: `#[range=user|<token>]` + `#[bg=surface0]` + `▌` in the status colour + the `format` body + one padding cell. Same look as the dash's selected row; field colours reuse the column roles (`FIELD_STYLE`), but the name is not bold (nothing competes with it).
- **Click tokens.** `chipToken(id)` = `CHIP_MARK` (`@`) + 14-char id prefix (tmux caps `range=user|X` at 15 bytes); `FILTER_TOKEN` (`@filter`) is the `▽` chip. `parseChipToken` is the inverse.
- **Filter.** `SHOW_TONES` defines each `ShowMode`; `SHOW_CYCLE` / `nextShow` is what the `▽` chip steps through. The chosen mode lives in `<cache>.show` (`cli/src/statusline-cache.ts`), read on every render by `notifyd` and `agmux statusline`; `cycleShowCmd` writes it and repaints the cache itself because notifyd only renders on row changes.
- **Click path.** `agmux.tmux` wraps `MouseDown1Status` / `MouseDown3Status` in `if-shell -F '#{m:@*,#{mouse_status_range}}'`: ours → `agmux statusline --click <left|right> <token>` (`cli/src/statusline-click.ts`); anything else → the original binding, saved once in `@agmux-orig-<key>`. Changing `CHIP_MARK` means changing that pattern too.
- **Style.** Everything visual is a template in `StatusLineStyle` (`DEFAULT_STYLE` = the look above); `fill()` substitutes `{key}` and skips tmux `#{…}`. Ranges are added outside the template. Sources and precedence (tmux `@agmux-statusline-*` > `config.toml` > default) live in `cli/src/statusline-style.ts`; a new template key needs an entry in `TMUX_STYLE_OPTIONS`, `lineStyle()` (config parsing) and the README styling table.
- **Placement** is `agmux.tmux`'s job: it sets `@agmux-chips` (`#(cat <cache>)`) and points `status-format[1]` / `status-right` at `#{E:@agmux-chips}`, or (`inline`) leaves that to the user.
- Agent-reported text goes through `escapeStyles` (`#[` → `##[`) — names must never open a tmux style.

## Table columns (`shared/columns.ts`)

`COLUMNS` is the registry; `[dash] columns` (validated in `cli/src/parse-dash.ts` against `COLUMN_KEYS`) picks and orders them, default `DEFAULT_COLUMNS`. Sorting (`shared/sort.ts`) cycles through the visible columns; last-seen newest-first is always the tie-break.

### Adding a column

1. Add the key to `COLUMN_KEYS` and a `ColDef` to `COLUMNS`: `header`, `align`, `style` (`state` | `faint` | `accent` | `sub` | `age` — a colour *role*, mapped to hexes in `SessionTable.cellColor`), `text(row, now)` (return `""` for missing, not `-`), optional `max` (hard cap) and `min` (shrink floor), and `shorten(text, width)` when a plain tail ellipsis loses the useful part (see `abbreviateBranch`).
2. If it may give way when the pane is narrow, add it to `SHRINK_ORDER` (earlier = squeezed first; `name` last).
3. Non-text sort semantics (numeric, rank) go in `sort.ts` `primary()` and `sortDirection()`; text columns sort a→z with blanks last for free.
4. Document it in the README `[dash] columns` list; extend `tests/shared/columns.test.ts`.

**Deferred:** a format-string column spec with per-column styling (e.g. `"{glyph} {name:bold} {repo:faint}"`). The `style` role on `ColDef` is the hook it would override.

## Attach targets (`shared/attach-targets.ts`)

`ATTACH_PLACEMENTS` (`@agmux/protocol`) is the slot order of the `A` popup; `attachTargets(kind, ctx)` says which are available and why not; `defaultPlacement` / `resolvePlacement` are what ⏎ and `agmux attach --placement` use, so popup and cli always agree. The cli side (tmux/terminal argv) is `cli/src/attach-place.ts`, executed in `cli/src/dash-actions.ts`. A command embedded in another tmux command (`new-window -- …`) must go through `nestedTmuxArgv`, or the outer tmux splits it at `;`. A command placed in a pane of its own goes through `holdOnFailure` (`cli/src/tmux-place.ts`; `splitPane` / `newWindow` / `newSession` apply it) so a fast failure stays readable until a key instead of closing the pane.

### Adding a placement

1. Append (never insert) to `ATTACH_PLACEMENTS`; add its label to `LABELS` and its availability rule to `reasonFor`.
2. Build its argv as a pure function in `cli/src/attach-place.ts` (tested), execute it in `makeActions` (`attach` for live, `resume` for closed).
3. Update the README slot list and `usage.ts`.
