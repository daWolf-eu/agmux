# agmux tmux plugin (TPM) — design

Date: 2026-06-18
Status: Approved design, pre-implementation
Branch: `feature/tmux-plugin`

## 1. Summary

A TPM-installable tmux plugin for agmux. A configurable keybinding (default `prefix + g`)
opens a tmux popup running `agmux dash`. Quitting dash closes the popup. Attaching to a
live session — or resuming a dead one — retargets the **parent** tmux client (not the
popup) and closes the popup, so the user lands directly on the agent.

MVP scope: install via TPM, the keybinding, the popup, popup auto-close on dash exit, and
parent-client handoff on attach/resume.

## 2. Goals / non-goals

**Goals**
- `set -g @plugin 'daWolf-eu/agmux'` + `prefix + I` installs the plugin.
- `prefix + g` (configurable) opens a popup with `agmux dash` running inside.
- Quitting dash (`q`) closes the popup.
- `⏎` on a live session switches the **parent** client to the agent's window and closes
  the popup.
- `r` on a dead session relaunches the agent into a new tmux window, switches the parent
  client to it, and closes the popup.

**Non-goals (MVP)**
- Toggle/dismiss binding (popup is modal — the parent client never sees a second
  `prefix + g` while the popup is open).
- Live re-read of plugin options after `agmux.tmux` load (standard TPM behavior: options
  resolved at source time).
- Any new dash feature beyond popup-aware exit-on-handoff.

## 3. Key insight

`agmux dash` already issues `tmux switch-client` for in-tmux attach
(`packages/cli/src/dash-actions.ts:21`). `switch-client` invoked from inside a
`display-popup -E` retargets the **underlying** client (the established
sesh / tmux-sessionizer pattern — the popup is an overlay on the existing client, not a
new client). The only gap: dash *stays alive* after attaching (returns `null`), so the
popup overlay keeps covering the agent the parent just switched to.

Fix: a popup-aware dash mode that **exits after switching**. Because the popup is launched
with `display-popup -E`, the popup closes automatically when its command exits — revealing
the now-switched parent client.

## 4. Components

### A. TPM plugin (shell) — new files

**`agmux.tmux`** (repo root, executable). TPM sources every `*.tmux` file at the plugin
repo's root; since the plugin *is* the agmux repo, the entry point lives at root. The
script:

- Reads options (with defaults) via `tmux show-option -gqv`:
  - `@agmux-key` → `g` (unbound in default tmux)
  - `@agmux-bin` → `agmux` (absolute-path override when not on tmux's PATH)
  - `@agmux-popup-width` → `80%`
  - `@agmux-popup-height` → `80%`
  - `@agmux-dash-args` → `""` (passthrough to dash, e.g. `--agent claude`)
- Binds the key:
  `bind-key <key> display-popup -E -w <W> -h <H> -- "<bin> dash --popup <args>"`
- Emits a non-blocking `display-message` warning if `<key>` is already bound under the
  prefix table (informational; still binds).

### B. `agmux dash --popup` (TS) — minimal changes

1. **`packages/cli/src/parse-dash.ts`** + `DashOpts`: parse `--popup` → `popup: boolean`
   (default `false`).
2. **`packages/cli/src/dash.ts`**: thread `opts.popup` into
   `makeActionsImpl(hubUrl, wrapBin, popup)`.
3. **`packages/cli/src/dash-actions.ts`** — `makeActions(hubUrl, wrapBin, popup = false)`:
   - **attach(row):**
     - not live / missing tmux coords → `null` (unchanged).
     - live + `popup` → issue `switch-client`/`select-pane` inline (existing
       `buildAttachCommands` in-tmux path), then return the **exit sentinel**
       `{ argv: [] }` → dash exits → popup closes → parent shows agent.
     - live + `!popup` → unchanged (inline switch, return `null`, dash stays alive).
   - **resume(row):**
     - `popup` → build the relaunch spec, open a **new tmux window** in the current
       session running the wrap argv (reuse `tmux-place.newWindow`, non-detached so the
       parent client switches to it), injecting only the **delta env** (the `AGMUX_*`
       keys whose value differs from `process.env`) via `-e`; return `{ argv: [] }`.
     - `!popup` → unchanged (returns a `Handoff` that takes over the terminal).
4. **`packages/tui/src/run-manage.tsx`**: guard the handoff spawn —
   `if (pending && pending.argv.length > 0)`. An empty `argv` Handoff means "exit dash
   cleanly, spawn nothing." Documented as a sentinel on the `Handoff` type in
   `packages/tui/src/types.ts`.
5. **`packages/cli/src/index.ts`**: wire `--popup` through dispatch into `dashCmd`.

## 5. Data flow

```
prefix + g
  └─ tmux display-popup -E  → runs `agmux dash --popup` inside an overlay on client C
       ├─ q                 → dash exit()        → process exits → popup closes (no handoff)
       ├─ ⏎ on live session → switch-client (retargets C) → attach returns {argv:[]}
       │                       → dash exits → popup closes → C now on agent window
       └─ r on dead session → newWindow(current session, wrapArgv, deltaEnv) [non-detached,
                               switches C] → resume returns {argv:[]} → popup closes
```

## 6. Error handling

- `--popup` with `$TMUX` unset: behave as normal dash (the popup only ever launches inside
  tmux, so this is a defensive fallback, not a supported path).
- Stale switch target / tmux command error: surfaced by the tmux call; dash still exits and
  the popup still closes.
- `agmux` not on tmux's PATH inside the popup: documented `@agmux-bin` absolute-path
  override.

## 7. Testing

**Unit**
- `parse-dash`: `--popup` present → `popup: true`; absent → `false`.
- `dash-actions` popup attach: live row issues `switch-client` (inject tmux exec) then
  returns `{ argv: [] }`; non-live returns `null`.
- `dash-actions` popup resume: calls `newWindow` with current session + wrap argv + delta
  env, returns `{ argv: [] }`.
- `run-manage`: empty-`argv` Handoff does not spawn a child.

Mirrors existing `packages/cli/tests/parse-dash.test.ts`, `dash.test.ts`,
`tmux-place.test.ts`.

**Manual checklist**
1. `set -g @plugin 'daWolf-eu/agmux'`, `prefix + I` → plugin installs.
2. `prefix + g` → popup opens with `agmux dash`.
3. `q` → popup closes, back to original pane.
4. `⏎` on a live session → popup closes, parent client now on the agent's window.
5. `r` on a dead session → popup closes, new window with relaunched agent is focused.
6. `set -g @agmux-key C-a` (or other) → rebound key opens the popup.

## 8. Open risks

- `switch-client` from inside a popup retargeting the parent client is the load-bearing
  assumption. Confirmed pattern in the wild (sesh, tmux-sessionizer); validated by manual
  checklist step 4 during implementation.
- `newWindow` non-detached behavior under a popup overlay: the window is created and the
  client switched; the switch becomes visible once the popup closes. Validated by checklist
  step 5.
