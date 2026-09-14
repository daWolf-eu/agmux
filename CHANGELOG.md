# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project aims to
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html). While in `0.x`
alpha, minor versions may include breaking changes.

The single source of truth for the running version is
`packages/protocol/src/version.ts` (reported by `agmux -v`).

## [Unreleased]

### Added
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
- Session glyphs now encode two independent axes: colour is status (green running,
  amber waiting, grey idle, red errored, dim grey closed/lost) and shape is
  read-ness (`●` unread, `○` read). This replaces the per-status shapes — `◉`
  waiting, `✕` errored, and `·` closed are gone, and `closed` was darkened to
  `#45475a` so it stays distinguishable from `idle` now that only colour
  separates them. Applies to both surfaces that draw glyphs, `agmux dash` and the
  tmux status line, and makes the `u` dismiss key visibly do something. Glyphs
  remain hard-coded; themes and customisation are not yet implemented.

### Fixed
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
