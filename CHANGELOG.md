# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project aims to
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html). While in `0.x`
alpha, minor versions may include breaking changes.

The single source of truth for the running version is
`packages/protocol/src/version.ts` (reported by `agmux -v`).

## [Unreleased]

### Added
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

### Fixed
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
