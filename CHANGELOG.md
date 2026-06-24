# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project aims to
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html). While in `0.x`
alpha, minor versions may include breaking changes.

The single source of truth for the running version is
`packages/protocol/src/version.ts` (reported by `agmux -v`).

## [Unreleased]

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
