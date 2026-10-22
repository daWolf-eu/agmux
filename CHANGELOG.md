# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project aims to
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html). While in `0.x`
alpha, minor versions may include breaking changes.

The single source of truth for the running version is
`packages/protocol/src/version.ts` (reported by `agmux -v`).

## [Unreleased]

### Added
- `[ui] remote_mark`: the mark before remote sessions in `ls`, the dash host column, status-line chips and the default remote `window_name` (default `⇄`; e.g. `"\uf0c2"`, the Nerd Font cloud). An invalid value warns and keeps the default.
- Remote sandbox attach (phase 2): `agmux attach <id> [--placement <p>] [--mode view|full]`, the dash `A` popup (`m` toggles the mode) and status-line clicks open a live sandbox session (inline / new pane / window / session / terminal), reuse an already open window of the same mode and name it `[attach.remote] window_name`. Modes: `view` (throwaway tmux view session, detach with `detach_key`, default `M-d`) and `full` (default outside tmux). Config `[attach.remote]`: `placement` (`new-window`), `mode` (`view`), `window_name` (`⇄ {title}`), `detach_key` (`M-d`). The sandbox needs only sh + tmux: three fixed sh scripts take row values as positional args only, validated first. The local pane process (`--remote-client`) tags its pane (`@agmux_session_id`, `@agmux_remote`, `@agmux_attach_mode`), starts a stopped sandbox and reaps the sandbox-side client on hangup, transport failure or the next attach with the same tag. Remote rows expose `remote_tmux` / `remote_pid` (`pid` / `tmux_*` stay null); `ls` renders the TMUX column from `remote_tmux`. Focusing a pane that shows a remote session marks it seen (`session.seen` stamped with the local host). A closed remote session's refused resume prints the command to run by hand. Remote kill / resume stay unsupported.
- Remote attach hardening: the pane tags are cleared when the remote client exits (a held failed window or the shell of an inline attach no longer wins dedup / focus-seen); the full-mode reap kills only a tmux attach client, never the sandbox's tmux server; a signal also hangs up the openshell child; a live remote row without tmux coordinates is no longer attachable; new-session names are `agmux-<id8>-<mode>`.
- dash: `A` opens an attach-target popup — inline, new pane, new window, new tmux
  session, new terminal tab/window. A live session is switched to (or opened from a new
  terminal); new pane/window/session resume a closed one. ⏎ defaults via `[attach] live` / `closed`;
  terminal launch templates via `[terminal] new_window` / `new_tab`.
  `agmux attach --placement <p>` exposes the same targets.
- dash: `[dash] columns` picks the table columns and their order, `[dash] header`
  shows the column-title row. New default columns: glyph, name, repo, branch,
  last seen; header off. Columns are content-sized and squeezed to fit the pane;
  a squeezed branch collapses a `feature|feat|bugfix|bug|chore|hotfix/` prefix to
  its initial (`f…/improve-…`) and keeps at least 8 characters of the name.
- Session metadata: a `session.metadata` event (schema v8, `session_meta`
  projection) carries the session's human-readable `name` and its git facts
  (`git_branch`, `git_repo`, `git_remote`, `git_root`). `agmux emit` collects
  them at registration and on every turn end: git via read-only `git` in the
  hook's cwd, the name via a new optional adapter hook `sessionName` (Claude
  transcript `custom-title`/`ai-title`, Codex `session_index.jsonl`, pi
  `getSessionName()`), falling back to the terminal-title name. `agmux ls` gains
  NAME, REPO and BRANCH columns; `agmux explain` shows both. pi extension 1.2.0.
- Always-visible tmux status line of live agent sessions (`agmux notifyd`,
  `agmux statusline`, `@agmux-statusline` plugin options). Falls back to
  `status-right` below tmux 3.3.
- Debounced, focus-aware notifications when a session needs input or finishes,
  via `terminal-notifier`, `osascript`, `notify-send`, or a custom command.
- Read/unread tracking: `session.seen` events, the `session_seen` projection,
  `agmux seen`, `?unread=1`, and a dash dismiss key (`u`).
- `run --headless`: a fourth placement that runs `--prompt`/`--prompt-file` as one
  non-interactive turn — no tmux, no PTY, the agent's stdout streamed through and
  its exit code returned, so it composes with pipes and redirection
  (`agmux run -p work --headless --prompt "..." > report.md`). The invocation is
  adapter-owned (claude `-p`, codex `exec`; pi reports unsupported). Headless runs
  are fully recorded sessions and can be resumed interactively via `agmux attach`.
- dash: activity-group filter — `f` cycles `open` / `closed` / `all`; the active
  group and per-group counts show in the header. The `/` free-text match is now
  labelled "search" to distinguish it from the filter.
- dash: pressing Enter on a closed session resumes it into a new window of the
  tmux session dash runs in (creating that session when dash runs outside tmux),
  then switches the client onto it. Attach/resume failures surface as a footer
  notice instead of a silent no-op.
- dash: `y` yanks a field of the selected session to the system clipboard via a
  digit-prefixed popup (autodetects pbcopy/wl-copy/xclip/xsel, OSC 52 fallback).
- Remote sandbox sessions (phase 1, read-only): `[[remote]]` in `config.toml` makes the
  hub pull the event logs of OpenShell sandboxes (`agmux events --follow` over
  `sandbox exec`, schema v9: `events.source`, `hosts`; v10: `source_db`). Sandboxes need `AGMUX_HOST`.
  Remote sessions appear in `ls`/`dash`/status line (`⇄ host`, `?` when stale);
  `ls --remote|--local|--host <glob>`, `[ls] locality`, dash `host` column and `r` key,
  sync state in `agmux hub status` (per remote: last discovery and its error, a broken
  config even while the hub is down) and `inspect`. Gone sandboxes turn `lost`, and so do
  the old sessions of a sandbox recreated under the same name. Discovery reads both
  `sandbox list -o json` shapes: a bare array and the paged `{ sandboxes, next_page_token }`.

### Changed
- dash restyle: no pane borders or titles — whitespace plus a faint vertical rule
  between table and preview; a `▌` selection bar in the row's status colour; names
  bold in the status colour, repo faint, branch pink, last-seen fading with age;
  header summary with per-status glyph counts; `[key] label` footer of everyday keys.
- Status palette and glyphs (dash and tmux status line): colour says what you have
  to do, shape repeats the state — `waiting` `?` yellow, `done` (finished, unseen)
  `●` green, `running` braille spinner lavender (was green), `idle` `○` grey,
  closed/lost `·` dim, errored `·` red. Replaces the per-status shapes `◉`/`✕`.
  Glyphs remain hard-coded; themes are not yet implemented.
- dash: default sort is by status (`waiting` › `done` › `running` › idle/closed),
  newest first within each; `s` cycles through the visible columns, with last seen
  as the tie-break.
- tmux status line: sessions render as chips (status-coloured `▌` bar on the
  surface0 highlight, fields in the dash's colour roles). Left-click switches to
  the pane and marks it seen, right-click only marks it seen. A trailing `▽`
  filter chip cycles `show` (`working` › `all` › `attention` › `waiting`;
  right-click backwards), saved across renders. Clicks outside the chips keep
  the original tmux bindings (window list, right-click menu). New placeholders
  `{name}`, `{repo}`, `{branch}`; default `format` is now `"{glyph} {name}"`.
- tmux status line `position = "inline"`: installs clicks and `@agmux-chips`
  (`#{E:@agmux-chips}`), leaves placement in your own `status-left/right`.
  `status2` and `status-right` now reference `@agmux-chips` too.
- tmux status line styling: chip, overflow and filter templates, separator,
  `format` and per-status colours, from `@agmux-statusline-*` tmux options
  (re-read by notifyd every tick) or `[statusline]` / `[statusline.colors]` in
  `config.toml`.
- `[statusline] show` gains `working` (waiting + done + running), the new
  default (was `all`).
- `agmux seen` resolves id prefixes against open sessions; `--all` marks every
  `done` session seen.
- `attach`, `resume` and `kill` refuse remote sessions; their `pid` and tmux coordinates
  are not exposed. Replicated events need a UUID `session_id` and a plain `event_id`;
  ids reach the notifier click action and status-line ranges only as `[0-9a-f-]`, and
  every `#` of agent text is doubled for tmux (no `#{…}`/`#(…)` from a session name).
  Sync errors and versions from sandboxes are stripped of control characters before
  they are stored or printed; session text (name, title, repo, branch, cwd, tool) is
  stored verbatim and printed with control characters replaced by `ls`, `watch`, `dash`
  (table, detail, yank), `explain` and the status line.

### Fixed
- Sessions launched through `agmux-wrap` stopped reaching the hub after `agmux hub
  restart`: the wrapper and its agent's hooks kept posting to the port the hub had
  when the session started, so heartbeats and events only went to the on-disk queue
  (drained at the next hub start) and the session drifted to `lost`. Both now fall
  back to the hub's port file when that URL fails.
- tmux status line froze after a reboot: nothing restarted `agmux notifyd`, the
  only writer of the cache it `cat`s, while the dash (hub auto-spawned) stayed live.
  The plugin now starts notifyd whenever it installs the status line.
- tmux status line: chips past `status-right-length` pushed the `▽` filter chip
  out of the bar (tmux clips from the end). The line now fits the room tmux gives
  it: names shrink evenly down to 9 cells, then the last chips fold into `+N`;
  the filter chip always stays. The room is read live from tmux;
  `@agmux-statusline-width` sets it for custom placements.
- An agent resumed or run into a new pane, window or session that failed to start
  (e.g. its working directory was gone) closed the pane at once, hiding the error.
  The pane now stays open on a non-zero exit until a key is pressed.
- `agmux dash`, `agmux watch` and `agmux notifyd` did not survive a hub restart.
  The polling feed resolved its URL once per subscription, but the hub binds an
  ephemeral port, so `agmux hub restart` moved it and every long-lived subscriber
  then polled a dead port indefinitely — silently, since "hub down" is a normal
  render state. Symptoms: a dash frozen on stale rows, notifications drying up
  for days, and a tmux status line reading "hub down" moments after a successful
  restart. The feed now re-resolves before every poll and recovers on its own.
  `resolveLiveHubUrl` prefers the live port file over `AGMUX_HUB_URL`, the
  reverse of `discoverHubUrl`: the wrapper injects that variable into every agent
  session, so a dash popup opened in an agent pane would otherwise follow a
  snapshot of the port the hub had when that session started.

- Every agmux command could die with `include file 'sys/ioctl.h' not found`. The
  PTY module compiles a small ioctl shim with TinyCC, and did so at import time;
  the wrapper barrel re-exports it next to the TOML config loaders, so `agmux hub
  restart`, `ls` and `dash` all compiled C just to read a config file — and a mac
  whose SDK headers had gone missing (an unaccepted Xcode licence after an
  update, or `xcode-select` pointing at a moved Xcode.app) could run nothing at
  all. The shim now includes no system headers, declaring `struct winsize` and
  `ioctl` itself; it is built on first use rather than on import; and if it
  cannot be built, agmux says resize will not propagate and carries on instead of
  throwing out of a SIGWINCH handler.

- notifyd re-fired the same notification for the whole length of a subagent's run.
  The attention episode was keyed on `activity_ts`, which also moves on every
  `tool.used`; since nothing moves a session out of `waiting`/`idle` in between
  (no adapter emits `input.received`, and Claude's `Stop` hook does not fire while
  a subagent runs), each of the subagent's tool calls minted a fresh episode and
  the next lull longer than `[notify].delay` re-announced the same prompt. Keyed
  on `attention_ts` now — bumped only by `input.required` / `turn.ended` /
  `session.ended`, which is exactly one episode — so a wait notifies once and a
  genuinely new attention event still re-arms. `attention_ts` is exposed on
  `SessionRow` for this.
- `[statusline] enabled` / `position` in `config.toml` were parsed and validated
  but never actually consulted — only the `@agmux-statusline` /
  `@agmux-statusline-position` tmux options controlled the status line, so
  setting them in config.toml silently had no effect. `agmux statusline
  --print-config` now exposes the resolved config-file values (always exits 0,
  falling back to defaults on any missing/invalid config), and `agmux.tmux`
  calls it once at plugin load to use as the default when the corresponding
  `@agmux-*` tmux option is unset; an explicitly set tmux option still wins.
  `[statusline].enabled` defaults to `false`, so the status line stays opt-in:
  with no config file and no tmux option set it stays off, exactly as before.
  Set `[statusline] enabled = true` in `config.toml`, or `@agmux-statusline on`
  in tmux, to turn it on.
- Multiple tmux servers: sessions now record the tmux server socket
  (`tmux_socket`, parsed from `$TMUX`) alongside session/window/pane, and every
  tmux command (`attach`, `switch-client`, `inject`, `capture-pane`, placement,
  resume) targets it with `-S <socket>`. Previously all commands hit the ambient
  server, so attaching to a session on a non-default server (`tmux -L name` /
  `-S path`) failed. `null` socket = ambient/default server (unchanged behavior).
  Also fixes native-session coord enrichment querying the wrong server.

## [0.1.0-alpha.1] — 2026-06-24

First public alpha. Shareable: clone, build, and run.

### Added
- Foundation: `@agmux/protocol` (event schema + ids), `@agmux/store` (SQLite event
  log + projections), `@agmux/hub` (local query daemon, binds `127.0.0.1`).
- Capture: `@agmux/wrapper` (transparent Bun PTY wrapper) and `@agmux/adapters`
  with native-hook adapters for `claude`, `codex`, and `pi` (session-id capture,
  `running`/`waiting` status).
- Consumers: `@agmux/cli` (`run`, `ls`, `watch`, `dash`, `attach`, `kill`,
  `inspect`, `adapter`, `hub`) and `@agmux/tui` (interactive dashboard).
- `agmux -h` / `--help` and `agmux -v` / `--version`.
- tmux plugin (TPM) binding a popup dashboard to `prefix + g`.

### Known limitations
- macOS verified; Linux portability best-effort and unverified in CI.
- No subagent spawning, multi-host, full output capture, or web dashboard yet.
- Alpha: APIs, schema, and CLI surface may change between releases.

[Unreleased]: https://github.com/daWolf-eu/agmux/compare/v0.1.0-alpha.1...HEAD
[0.1.0-alpha.1]: https://github.com/daWolf-eu/agmux/releases/tag/v0.1.0-alpha.1
