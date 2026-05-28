# agmux

A consolidated central hub for AI agent sessions — Claude Code, Codex, Gemini, opencode, pi, and others. Records every session as it happens and exposes the data to a family of decoupled, opt-in services: analytics, dashboard, TUI/CLI management, inter-agent comms, and agent-to-agent orchestration.

**Status:** MVP slice (`protocol + store + hub + wrapper + cli`) implemented. macOS-verified; Linux portability is best-effort and unverified in CI.

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

## Quickstart (MVP)

```bash
# Install + build the three binaries
bun install
bun run --filter @agmux/hub build
bun run --filter @agmux/wrapper build
bun run --filter @agmux/cli build

# Symlink onto PATH (or use the dist paths directly)
ln -sf "$(pwd)/packages/hub/dist/agmux-hub"      /usr/local/bin/agmux-hub
ln -sf "$(pwd)/packages/wrapper/dist/agmux-wrap" /usr/local/bin/agmux-wrap
ln -sf "$(pwd)/packages/cli/dist/agmux"          /usr/local/bin/agmux

# Configure a profile
mkdir -p ~/.config/agmux
cat > ~/.config/agmux/config.toml <<'TOML'
[profiles.claude-work]
agent_kind = "claude"
command = "ccc"
args = []

[profiles.claude-private]
agent_kind = "claude"
command = "cc"
args = []

[profiles.codex-default]
agent_kind = "codex"
command = "codex"
args = []

# By default profiles spawn via `$SHELL -ic 'exec <command> <args>'` so
# user-defined shell aliases (like `ccc` above) resolve. Set use_shell = false
# for compound aliases or when you want raw execvp on an absolute path.
# use_shell = false
TOML

# Use it
agmux run claude-work        # launches into a new tmux window
agmux ls                     # list live sessions
agmux attach <prefix>        # re-enter a session (tmux switch live; agent-resume if dead)
agmux kill   <prefix>        # signal it (default SIGTERM)
agmux inspect <prefix>       # full row + recent events as JSON
```

State lives in `~/.agmux/` — `agmux.sqlite` (event log + projection), `hub.pid` / `hub.port`, and a `queue/` directory for write-through fallback when the hub is briefly unreachable. The hub auto-spawns on first invocation; binds 127.0.0.1 only.

Environment overrides:
- `AGMUX_HUB_BIN`, `AGMUX_WRAP_BIN` — paths for `agmux` to spawn the hub / wrapper from. Defaults assume the binaries are on `PATH`.
- `AGMUX_TMUX_SESSION` — tmux session name used by the wrapper (default `agmux`). Override for test isolation.

## Implementation status

See [`docs/superpowers/specs/2026-05-28-mvp-slice-design.md`](docs/superpowers/specs/2026-05-28-mvp-slice-design.md) for the design and [`docs/superpowers/plans/2026-05-28-mvp-slice.md`](docs/superpowers/plans/2026-05-28-mvp-slice.md) for the implementation plan. Out of MVP per the spec: adapters (per-agent native session-id capture and `running`/`waiting` status), subagent spawning, multi-host, output capture, dashboard/TUI/insights/comms.
