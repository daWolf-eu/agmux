# Rex multiplexer support: design

**Date:** 2026-11-02
**Status:** approved
**Scope:** one phase. There are no follow-up phases.

## 1. Intent

Rex is a terminal app and multiplexer that replaces both the terminal and tmux. David works inside Rex and doesn't want to run tmux inside it unless that is the only way to reach something.

agmux should treat Rex as an interchangeable multiplexer: the same job as tmux, with the same behaviour for the user. Agents started in Rex are tracked with Rex coordinates, and the dash can jump between sessions whichever multiplexer they live in.

**Done means:** the agmux CLI and dash work inside Rex as they do inside tmux today.

## 2. Goals, non-goals, anti-goals

**Goals**

- Detect Rex for agents started through `agmux run` and for agents started directly (hook registration).
- Record Rex session, window and block coordinates on the session row.
- Support `agmux run` inside Rex: inline and `--new-pane`, `--new-window`, `--new-session`, including `-d` and `--prompt`.
- Support `agmux attach` and every dash action inside Rex: open, resume, placements, preview, kill, seen, yank, search.
- Support prompt injection, native-session title signals and "attached" highlighting for Rex sessions.

**Non-goals**

- Rex configuration: status line, keybindings, the Rex equivalent of `agmux.tmux`. The dash float already exists in the user's `init.lua` (`agmux dash --popup` in a floating layer) and is handled elsewhere.
- A tmux status line that understands Rex beyond showing a readable label.
- Rex inside sandboxes. The sandbox side of remote sessions stays tmux.
- Attaching a plain terminal to a Rex session. Rex offers no terminal client for that.
- Migrating past tmux sessions. Old rows keep working as tmux rows.

**Anti-goals: this has failed if, even with Rex working:**

- Anything outside Rex behaves differently. A plain terminal and tmux keep today's behaviour exactly, apart from opening a session that lives in Rex (§5.3).
- An agent in Rex needs tmux installed or starts a tmux server.
- tmux runs inside a Rex tab for anything except showing a session that is live in tmux.
- Probing a row starts a Rex server the user didn't start.

## 3. Rule for where we are

Implement once, as `detectMux(env)` in `@agmux/protocol`. Nothing else reads these variables to decide.

| Environment | Result |
| --- | --- |
| `TMUX` set | `tmux` |
| `REX_BLOCK` set, `TMUX` unset | `rex` |
| Neither | `null` |

tmux wins because it is the innermost layer when tmux runs inside a Rex tab: the agent really is in a tmux pane, and those panes inherit stale `REX_*` values.

## 4. Data model

Decided: one location per session, in the existing columns, with a discriminator. The columns keep their `tmux_*` names, to avoid a rename across the protocol, store, TUI and about 100 test references.

| Row field | tmux | Rex |
| --- | --- | --- |
| `mux` (new, nullable) | `tmux` or null | `rex` |
| `tmux_session` | session name | `session:<uuid>` |
| `tmux_window` | `@N` | `window:<uuid>` |
| `tmux_pane` | `%N` | `block:<uuid>` |
| `tmux_socket` | socket path | `$REX_SERVER` |
| `tmux_server` | `<pid>-<start_time>` | null |
| `mux_label` (new, nullable) | null | session label at registration |

Rules:

- A null `mux` means tmux, so old events replay to the same rows. The change is additive (foundation §14.7): optional fields on `session.started`, `session.registered` and the reattach event (`new_mux`, `new_mux_label`), plus a migration adding two nullable columns.
- **The projection must replace, not merge, when `mux` changes.** Today's `COALESCE` keeps an old value when the new one is null. A Rex row resumed in tmux on the default socket would keep the Rex endpoint as its socket and the old server id. When a payload's `mux` differs from the row's, all location fields are overwritten, including with null. Same `mux`: today's rules.
- Rex ids are UUIDs and aren't reused, so `tmux_server` isn't needed to detect a restarted server.
- Every code path that hands `tmux_*` values to a command must branch on `mux`. Passing a `block:` id to tmux is a bug. Plan an audit of all `tmux_*` reads; `packages/cli` and `packages/tui` hold nearly all of them.
- Display goes through one helper. Rex rows show `rex:<label>`, never raw UUIDs, in the dash column, detail pane, yank, search, notifications and tmux status line. The column header changes from `TMUX` to `MUX`.

## 5. Behaviour

### 5.1 Starting an agent inside Rex

- The wrapper and direct launches run the agent in the current block and record coordinates. The `tmux not found` and version checks don't run. `run.ts`'s "direct and not in tmux" fallback treats Rex as being in a multiplexer.
- Native agents: the adapters' `normalize.ts` read `TMUX_PANE`, and `emit` enriches registration. Both gain a Rex path: `rex whoami --json` returns session, window and block ids in one call, and `session.label` comes from `rex ls --json` or `rex session inspect`. Failure leaves coordinates null, as with tmux, and never fails the hook.
- `scrubTmuxEnv` and `withoutTmuxEnv` also strip `REX_BLOCK`, `REX_SESSION` and `REX_SERVER`, for the same reason: a headless agent or a new terminal must not claim the caller's pane.

| Placement | Rex command | Notes |
| --- | --- | --- |
| new pane | `rex split -s S -b BLOCK --json -- CMD` | `--focus=false` for `-d` |
| new window | `rex window new -s S LABEL --json -- CMD` | current session; `--focus=false` for `-d` |
| new session | `rex new LABEL --json -- CMD`, then `session.select` unless `-d` | same name scheme as tmux |

- Rex has no per-pane env flag. Pass env with `env K=V … CMD`, keeping Rex's default login-shell environment, ahead of the existing `holdOnFailure` wrapper. Don't use `--keep-open`: it would hold panes after success too.
- `AGMUX_TMUX_SESSION`, when set, is honoured as a Rex session label for `--new-window`: use the session with that label, or create it.
- Save ids from `--json` output (`.session_id`, `.window_id`, `.block_ids[0]`).

### 5.2 Opening a session from inside Rex (⏎ or `agmux attach`)

Approved by David:

| Session state | Behaviour |
| --- | --- |
| Live in Rex | Focus its block. If it's in another Rex session, switch the app there. |
| Live in tmux | Open a new Rex tab running `tmux attach`, on that session's server, selecting its window and pane. Runs in a tab because `agmux_dash` is a float and would die with the attach. |
| Pane gone or session closed | Resume with the default placement: a new tab in the current Rex session, under the same `session_id`. tmux isn't involved, even for a session that used to be in tmux. |
| "Live" but pane actually gone | Same as gone: check first, then resume. |
| Rex server unreachable | Don't resume. Report it (see below). |

Details:

- **The existence check has three results for a Rex row: present, gone, unreachable.** Exit 3 from `rex block inspect` is gone. Exit 4 (server down), a timeout or a missing binary is unreachable. Only gone leads to a resume, because a hung server may still be running the agent and a resume would put two agents under one `session_id`. This applies inside and outside Rex. A row whose server really died stops being live once the lost sweep marks it, and then resumes normally. `decideAttach` and `sessionExists` change accordingly, and tmux maps onto present and gone only.
- Focus means `session.focus_block`, then `rex -C CLIENT do session.select session_id=S window_id=W`. `focus_block` alone doesn't move the app between sessions.
- CLIENT is the `owner` of `$REX_BLOCK` from `rex block inspect`, which is the app the dash runs in, when the row is on the caller's server. If there's no owner, or the row is on another server, use the sole connected client with `info.kind == "app"` on the row's server. If several apps are connected and none can be chosen, focus only and show a notice.
- **The current block.** Inside the dash float, `$REX_BLOCK` is the float itself, which closes with the dash. Placements must anchor on the block underneath: in `--popup`, read `session.view` and take the focused block of the active window's tiled layer. If that can't be derived, `new-pane` fails with today's `cannot read the current pane` error, and `new-window` still works because it needs only the session. No `init.lua` change is required.
- Popup behaviour matches tmux: `--popup` returns an empty handoff, so the float closes onto the target. An inline dash stays open.
- Tmux tabs are deduplicated per tmux server and session, not per agmux session, because several rows commonly share the `agmux` tmux session and separate clients would mirror each other. The block label is built from the socket and session, for example `agmux:tmux:<hash>`. If that block still exists in the current Rex session, focus it and run `select-window` and `select-pane` on that tmux server rather than opening another tab.
- Live in tmux while the tmux server is gone: already handled by the existence check, which resumes in Rex.
- Placement pickers: the "not in tmux" reasons pass inside Rex, so `new-pane`, `new-window` and `new-session` are all available for a resume. `AttachCtx.inTmux` becomes `inMux`, because it now means either multiplexer. Live sessions keep "already open" as the reason other placements are disabled, and the tab in the tmux case is still the `inline` target.
- `new-tab` and `new-terminal` stay available when configured in `[terminal]`. They are an explicit override: the new terminal is outside Rex, so §5.3 applies there, and a resume in it can use tmux. No default ever picks them unless `[attach]` is configured to.

### 5.3 Outside Rex

Unchanged, including `agmux run` from a plain terminal, which still creates the `agmux` tmux session. The one addition is opening a row that lives in Rex:

- Live in Rex: focus its block and bring the Rex app to it, as in §5.2, using `-S` with the row's endpoint. The dash reports `opened in Rex`, and `agmux attach` prints the same line and exits 0.
- No Rex app connected, or the server is down: report that clearly. Don't resume, because the agent may still be running there.
- Closed Rex row: resume by today's rules for the caller's location. The row then moves to that multiplexer (§4).

### 5.4 Remote sessions opened inside Rex

The sandbox side doesn't change. The local client (`agmux attach --remote-client`) is placed through the same Rex placements, and `remote-client.ts` itself needs no Rex path: the existing non-tmux path covers `$TMUX_PANE` being absent.

- The default mode inside Rex is the same as inside tmux: `[attach.remote] mode`, default `view`. Detaching ends the client and closes its tab, which is the equivalent of returning to tmux. So `attachRemote`'s `ctx.inTmux` gate follows the `inMux` rename deliberately.
- Dedup uses a block label set at placement, keyed by session id and mode, in place of `listPanes` and pane options. An `inline` remote attach sets no label on the user's own block, so it isn't deduplicated. A held, failed client keeps its label until its block closes, so ⏎ focuses the error.
- `agmux seen --pane` doesn't recognise remote client blocks. Opening or dismissing the row still marks it seen.

### 5.5 Feature mapping

| Feature | tmux today | Rex |
| --- | --- | --- |
| Pane exists | `has-session` | `rex block inspect BLOCK --json`, exit 3 = gone |
| Preview | `capture-pane -p` | block `format` (see risk R1) |
| Injection: clear line | `send-keys C-a`, `C-k` | `send-key ctrl+a ctrl+k` |
| Injection: paste | `load-buffer`, `paste-buffer -p -d` | `block.event` type `paste` via `rex api call` with `@file` or stdin, so size isn't limited by argv |
| Injection: submit | `send-keys Enter` | `send-key enter` |
| Injection: readiness | `capture-pane` polling | same logic, using the preview capture |
| Native titles | `list-panes -a` | block method `title`, one call per block (R2) |
| Watching-finish seen | `list-clients` focus flags | not available (L1) |
| Toast | `display-message` | none in Rex; a running tmux client may show `rex:<label>`; OS notifications unchanged (L2) |
| Attached highlight | active pane via `display-message` | active window's `focused_block_id` from `session inspect` (R3) |
| `agmux seen --pane` | pane id + socket | works with a block id, so a user's `rex.on` hook can call it |
| Kill | `pid` | unchanged |

Injection stays spawn/bootstrap only (§14.9), and the verified-submit logic is shared, with only its primitives swapped.

### 5.6 Calling Rex

All calls go through one helper:

- **Binary:** `rex` isn't on `PATH` outside Rex, and notifyd usually runs outside it. Resolve in order: `PATH`, `$REX_BIN_DIR/rex`, then the macOS app location `~/Library/Application Support/com.superlogical.rex/RexServer/Versions/Current/Rex Server.app/Contents/MacOS/rex`. A missing binary means "unavailable", handled like tmux being absent.
- **Always `--autostart=false`** on anything that targets a row, so a probe never starts a server.
- **Always `-S <row endpoint>`** for a row, and from `$REX_SERVER` for the current location. An inherited `REX_SERVER` may be stale.
- **Short `--timeout`** on probes and polling, so a hung server can't stall the dash.
- **Full ids only.** Labels and suffixes can be ambiguous.
- Values are separate argv elements and are never joined into a shell string.

## 6. Structure

Builder's call on details. The intent: one seam, not `if (rex)` scattered through callers.

- `@agmux/protocol`: `MuxKind`, `detectMux`, the new fields, display helper inputs.
- `@agmux/store`: migration, projection rule (§4), row mapping.
- `@agmux/wrapper`: Rex coordinate reading.
- `@agmux/cli`: a `Mux` interface over the operations in §5, with the tmux implementation wrapping existing code and a Rex implementation in new modules. Callers select by the row's `mux` or the caller's location. Existing injectable deps stay injectable.
- `@agmux/tui`: `attachKind`, `AttachCtx`, display helper, attached highlight.
- Docs: foundation (fields in the session model, standing principle 5 extended to Rex), README, CONTRIBUTING, `packages/cli/AGENTS.md`, the `agmux-overview` skill.

`bun run typecheck` and `bun test` stay green. tmux code paths and their tests shouldn't need behavioural changes, which is the best check on the first anti-goal.

## 7. Testing

- CI has no Rex. Unit tests use the injectable exec seam. Add a fake `rex` executable for command-level tests, in the style of `tests/e2e/stub-claude.sh` and the fake openshell.
- Must-have tests: `detectMux` table; the attach matrix (caller rex/tmux/none × row rex/tmux × live/stale/unreachable/closed); projection replacing fields on a `mux` change in both directions; old events replaying unchanged; `--autostart=false` on every row-targeting call.
- Manual smoke inside real Rex, recorded in the plan. It's required because the done criterion is real use:
  1. `agmux run` inline and all three placements, with and without `-d`.
  2. A native `claude` started in a Rex tab appears with coordinates.
  3. Dash float: open a Rex session in the same tab, another tab and another session.
  4. Dash float: open a live tmux session, then press ⏎ again and confirm no duplicate tab.
  5. Close a session and resume it, for a Rex row and a tmux row.
  6. `--prompt` injection with a multi-line prompt.
  7. Preview on a session with long scrollback, watching responsiveness.
  8. From a plain terminal and from tmux: open a Rex session, with the app running and with it quit.
  9. Dash float: resume with `new-pane`, then confirm the agent survives the float closing.
  10. Open a remote session from the float, then detach. This needs a sandbox, so run it on the homelab if one isn't available locally.
  11. Confirm tmux behaviour is unchanged.

## 8. Known limits

- **L1: no "seen while watching" in Rex.** Rex doesn't expose OS focus or which session an app is showing (`client.inspect` and `session.list_clients` have neither), so a session finishing in front of you stays `done` until you open or dismiss it. This errs the same way the tmux code does: it never hides a session. `focused_block_id` must not be used instead, because it's set even when the app is showing another session.
- **L2: no in-app toast.** The tmux toast has no Rex equivalent in the actions available, so nothing shows inside Rex. The toast path doesn't branch on `mux`: a running tmux client may show a Rex row as `rex:<label>`. No Rex id reaches tmux. OS notifications still fire, and suppress-when-visible only applies to the toast.
- **L3: bringing the app forward.** `session.select` changes what the app shows. It may not raise the app over other macOS apps. Accept that unless smoke testing shows it's a problem.
- **L4: leaked `TMUX`.** A Rex server autostarted from inside tmux could give its blocks a stale `TMUX`, and §3 would then report tmux. Rex normally starts from the app, so this is accepted. Confirm during smoke testing.

## 9. Risks to settle early in the plan

- **R1: preview cost.** `capture-pane -p` returns the visible screen. Rex's `capture` and `format` return the screen plus all scrollback (up to about 64 MiB), and `max_bytes` keeps the start, not the end. Measured on live blocks of up to 9 KB, `format` with `max_bytes` took about 30 ms and its reply gives `total`, so a tail read is `format` then `blob_read` at `total - N`. Long scrollback is unmeasured, so test a block with several MiB first. Target: one bounded tail read within 250 ms. If a read exceeds that, back off that block's preview and readiness polling to at least 1 s rather than blanking the preview. Readiness has a 30 s budget, so slower polling costs latency only. Never fetch full scrollback on a polling path.
- **R2: title polling cost.** One subprocess per native Rex session per tick, measured at about 30 ms each. If that's noticeable with many sessions, poll Rex titles less often or use `rex events`.
- **R3: highlight under a float.** Uses the same tiled-layer lookup as "the current block" in §5.2. If it can't be derived, show no highlight for that case.
- **R4: `-S` with an endpoint.** `REX_SERVER` is a percent-encoded `unix://` URL. Confirm `-S` accepts it verbatim.
- **R5: argv through the login shell.** Confirm `;` elements for `tmux attach` and JSON values such as `AGMUX_INLINE_PROFILE` survive Rex's default shell handling unchanged. If not, use `--shell=none` with an explicit `PATH`.
- **R6: float close order.** Confirm focusing a block in the same window while the float is on top leaves focus on the target after the float closes.
- **R7: float details.** Confirm that `$REX_BLOCK` in a float is the float's own block, and whether its `owner` is set. §5.2 assumes the first and has a fallback for the second. This was inferred from `init.lua`, not observed.

## 10. Left to the builder

- Module names, `Mux` interface shape, and migration numbering.
- Task order, as long as Rex detection and storage land before anything depends on them.
- Poll intervals on Rex paths, within R1 and R2.
- Exact notice wording.
