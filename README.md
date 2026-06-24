# agmux

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Platform: macOS](https://img.shields.io/badge/platform-macOS-blue)
![Status: alpha](https://img.shields.io/badge/status-alpha-orange)

A consolidated central hub for your AI agent sessions — Claude Code, Codex, pi, and others.

If you run more than one coding agent, you lose track of them fast: which sessions are live, which are waiting on you, what each one is doing, and how to jump back into the right tmux pane. `agmux` records every session as it happens into a local-first store and gives you one place to **see, search, attach to, and manage** them — from the CLI, an interactive TUI, or a tmux popup.

**Status:** alpha (`v0.1.0-alpha.1`). The foundation (`protocol + store + hub + wrapper`), agent adapters (`claude`, `codex`, `pi`), and the `cli` + `tui` consumers are implemented. macOS-verified; Linux portability is best-effort and unverified in CI. Expect rough edges and breaking changes between alpha releases.

## Read first

- [`docs/agmux-foundation.md`](docs/agmux-foundation.md) — vision, architecture, package decomposition, and standing principles. Every per-service design doc builds on this.
- [`docs/spikes/2026-05-27-bun-pty/SPIKE_REPORT.md`](docs/spikes/2026-05-27-bun-pty/SPIKE_REPORT.md) — feasibility proof for a transparent TS-on-Bun PTY wrapper; `wrapper.ts` is the reference for the eventual `@agmux/wrapper` package.

## Layout

Monorepo with Bun workspaces:

```
packages/
  protocol/  store/  hub/        # foundation: schema, SQLite store, query daemon
  wrapper/   adapters/           # capture: PTY wrapper + per-agent native hooks
  cli/  tui/                     # consumers: management verbs + interactive dashboard
```

The foundation persists an append-only event log and serves a local query API over `127.0.0.1`. Adapters and consumers layer on top of it. Future, not-yet-built services (web dashboard, insights, inter-agent comms) plug into the same API — see [`docs/agmux-foundation.md`](docs/agmux-foundation.md).

## Prerequisites

- [Bun](https://bun.com) ≥ 1.3 — the only runtime; there is no Node.js fallback.
- [tmux](https://github.com/tmux/tmux) ≥ 3.2 — for session placement, `attach`, and the dashboard popup.
- The agent CLIs you want to track on your `PATH` (e.g. `claude`, `codex`, `pi`).
- macOS (verified). Linux is best-effort and unverified.

## Quickstart

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

[profiles.pi-default]
agent_kind = "pi"
command = "pi"
args = []
TOML

# Use it — two ways to launch:
agmux run claude --resume abc            # ad-hoc: command + args; agent_kind detected from basename
agmux run --kind=codex /opt/codex-rc1    # explicit --kind for unknown binary names
agmux run -p claude-work                 # profile from ~/.config/agmux/config.toml
agmux run -p pi-default                   # PI session (auto-discovered extension)

agmux ls                     # recent 50 sessions (any status) — newest first
agmux ls -n 5 -r             # 5 most recent, newest at the bottom (above your prompt)
agmux ls --sort activity     # order by last activity instead of start time (--asc to flip)
agmux ls --status active     # active (running|waiting), open (+idle), closed (ended|lost), or raw statuses
agmux ls --all               # uncapped   (--live = alias for --status open)
# ls/watch show an ACTIVITY column: current tool while running, awaited input kind while waiting
agmux watch                  # fullscreen live view of ls (status open, sorted by start); q quits
agmux watch -i 2 --agent claude   # accepts ls filter flags + -i/--interval seconds
agmux dash                         # interactive TUI: sortable session table + preview pane; q quits
agmux dash -i 2 --agent claude     # accepts ls filter flags + -i/--interval
agmux dash --preview detail        # default preview tab (mirror|detail)
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

`dash` keys: `j/k` move · `g/G` top/bottom · `s` sort · `/` filter · `tab` preview tab ·
`p` show/hide preview · `⏎` attach (switch-client) · `x` kill · `?` help · `q` quit.
Config under `[dash]` in `~/.config/agmux/config.toml`: `preview`, `interval`, `status`, `sort`.
Run it inside tmux so `⏎` switches you to the agent's window while dash stays alive.

## tmux plugin (TPM)

Requires tmux ≥ 3.2 (`display-popup`) and `agmux` on tmux's PATH (or set `@agmux-bin`).

```tmux
# ~/.tmux.conf
set -g @plugin 'daWolf-eu/agmux'
run '~/.tmux/plugins/tpm/tpm'
```

Then `prefix + I` to install. `prefix + g` opens a popup running `agmux dash`:

- `q` closes the popup.
- `⏎` on a live session switches the parent client to the agent's window and closes the popup.
- `r` on a closed session relaunches it into a new window, switches there, and closes the popup.

Options (set before the `run` line):

| Option                | Default | Meaning                                              |
| --------------------- | ------- | ---------------------------------------------------- |
| `@agmux-key`          | `g`     | key under the prefix table                           |
| `@agmux-bin`          | `agmux` | agmux binary (use an absolute path if not on PATH)   |
| `@agmux-popup-width`  | `80%`   | popup width                                          |
| `@agmux-popup-height` | `80%`   | popup height                                         |
| `@agmux-dash-args`    | (empty) | extra args appended to `agmux dash` (e.g. `--agent claude`) |

`@agmux-dash-args` is run through the popup's shell — keep it to plain flags.

State lives in `~/.agmux/` — `agmux.sqlite` (event log + projection), `hub.pid` / `hub.port`, and a `queue/` directory for write-through fallback when the hub is briefly unreachable. The hub auto-spawns on first invocation; binds 127.0.0.1 only.

Environment overrides:
- `AGMUX_HUB_BIN`, `AGMUX_WRAP_BIN` — paths for `agmux` to spawn the hub / wrapper from. Defaults assume the binaries are on `PATH`.
- `AGMUX_TMUX_SESSION` — tmux session name used by the wrapper (default `agmux`). Override for test isolation.

## Troubleshooting

- **`agmux: command not found`** — the binaries aren't on your `PATH`. Re-check the symlink step, or point `AGMUX_HUB_BIN` / `AGMUX_WRAP_BIN` at the `dist/` paths.
- **Sessions don't show as `running`/`waiting`** — that status comes from a per-agent adapter. Install it once with `agmux adapter install <profile>` (or `--kind <agent>`); check state with `agmux adapter status`.
- **Hub seems stale or wedged** — `agmux hub status` shows the running vs installed version; `agmux hub restart` rolls it gracefully. State lives in `~/.agmux/`.
- **`dash` exits immediately** — it needs a TTY. Use `agmux ls` for scripted/non-interactive output.

## Status & roadmap

Implemented: foundation (`protocol + store + hub + wrapper`), adapters (`claude`, `codex`, `pi`) for native session-id capture and `running`/`waiting` status, and the `cli` + `tui` consumers. Not yet built: subagent spawning, multi-host, full output capture, and the web dashboard / insights / inter-agent comms services. Architecture and standing principles live in [`docs/agmux-foundation.md`](docs/agmux-foundation.md).

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the build, test, and layout notes. Issues and PRs welcome — it's alpha, so feedback on rough edges is especially useful.

## License

[MIT](LICENSE) © David Wolf
