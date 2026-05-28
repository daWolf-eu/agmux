# agmux

A consolidated central hub for AI agent sessions — Claude Code, Codex, Gemini, opencode, pi, and others. Records every session as it happens and exposes the data to a family of decoupled, opt-in services: analytics, dashboard, TUI/CLI management, inter-agent comms, and agent-to-agent orchestration.

**Status:** Foundation phase. Not yet implemented.

## Read first

- [`docs/agmux-foundation.md`](docs/agmux-foundation.md) — vision, architecture, package decomposition, and standing principles. Every per-service design doc builds on this.
- [`docs/spikes/2026-05-27-bun-pty/SPIKE_REPORT.md`](docs/spikes/2026-05-27-bun-pty/SPIKE_REPORT.md) — feasibility proof for a transparent TS-on-Bun PTY wrapper; `wrapper.ts` is the reference for the eventual `@agmux/wrapper` package.

## Layout (target)

Monorepo with Bun workspaces:

```
packages/
  protocol/    store/    hub/         # foundation
  wrapper/     adapters/              # capture
  cli/  tui/  dashboard/  insights/  comms/   # consumers (all optional)
```

Foundation (`protocol + store + hub + wrapper`) is the MVP slice; everything else layers on top of its query API.
