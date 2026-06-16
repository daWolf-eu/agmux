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

# Configure a profile.
# `command` is exec'd directly via PATH lookup — shell aliases and built-ins
# are NOT resolved. Use absolute paths or rely on PATH. Put env overrides and
# flags in the profile itself.
mkdir -p ~/.config/agmux
cat > ~/.config/agmux/config.toml <<'TOML'
[profiles.claude-work]
agent_kind = "claude"
command = "claude"
args = []
env = { ANTHROPIC_API_KEY = "..." }

[profiles.claude-private]
agent_kind = "claude"
command = "claude"
args = []

[profiles.codex-default]
agent_kind = "codex"
command = "codex"
args = []
TOML

# Use it — two ways to launch:
agmux run claude --resume abc            # ad-hoc: command + args; agent_kind detected from basename
agmux run --kind=codex /opt/codex-rc1    # explicit --kind for unknown binary names
agmux run -p claude-work                 # profile from ~/.config/agmux/config.toml

agmux ls                     # recent 50 sessions (any status) — newest first
agmux ls -n 5 -r             # 5 most recent, newest at the bottom (above your prompt)
agmux ls --sort activity     # order by last activity instead of start time (--asc to flip)
agmux ls --status active     # active (running|waiting), open (+idle), closed (ended|lost), or raw statuses
agmux ls --all               # uncapped   (--live = alias for --status open)
# ls/watch show an ACTIVITY column: current tool while running, awaited input kind while waiting
agmux watch                  # fullscreen live view of ls (status open, sorted by start); q quits
agmux watch -i 2 --agent claude   # accepts ls filter flags + -i/--interval seconds
agmux dash                         # lazygit-style TUI: grouped table + preview pane; q quits
agmux dash -i 2 --agent claude     # accepts ls filter flags + -i/--interval
agmux dash --preview detail        # default preview tab (mirror|events|detail)
agmux attach <prefix>        # live → tmux switch; ended/lost → relaunch w/ same session_id
agmux kill   <prefix>        # signal it (default SIGTERM)
agmux inspect <prefix>       # full row + recent events as JSON
```

`ls` defaults are configurable in `~/.config/agmux/config.toml` (CLI flags win):

```toml
[ls]
limit = 10
sort = "activity"   # started | activity
asc = false
reverse = true      # newest at the bottom
status = "open"     # active | open | closed | comma-separated statuses
```

`dash` keys: `j/k` move · `{ }` group jump · `< >` resize split · `tab` preview ·
`⏎` attach (switch-client) · `x` kill · `r` resume closed · `/` filter · `?` help · `q` quit.
Config under `[dash]` in `~/.config/agmux/config.toml`: `preview`, `interval`, `status`, `sort`.
Run it inside tmux so `⏎` switches you to the agent's window while dash stays alive.

State lives in `~/.agmux/` — `agmux.sqlite` (event log + projection), `hub.pid` / `hub.port`, and a `queue/` directory for write-through fallback when the hub is briefly unreachable. The hub auto-spawns on first invocation; binds 127.0.0.1 only.

Environment overrides:
- `AGMUX_HUB_BIN`, `AGMUX_WRAP_BIN` — paths for `agmux` to spawn the hub / wrapper from. Defaults assume the binaries are on `PATH`.
- `AGMUX_TMUX_SESSION` — tmux session name used by the wrapper (default `agmux`). Override for test isolation.

## Implementation status

See [`docs/superpowers/specs/2026-05-28-mvp-slice-design.md`](docs/superpowers/specs/2026-05-28-mvp-slice-design.md) for the design and [`docs/superpowers/plans/2026-05-28-mvp-slice.md`](docs/superpowers/plans/2026-05-28-mvp-slice.md) for the implementation plan. Out of MVP per the spec: adapters (per-agent native session-id capture and `running`/`waiting` status), subagent spawning, multi-host, output capture, dashboard/TUI/insights/comms.
