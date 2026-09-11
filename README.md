# agmux

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Platform: macOS](https://img.shields.io/badge/platform-macOS-blue)
![Status: alpha](https://img.shields.io/badge/status-alpha-orange)

A consolidated central hub for your AI agent sessions — Claude Code, Codex, pi, and others.

If you run more than one coding agent, you lose track of them fast: which sessions are live, which are waiting on you, what each one is doing, and how to jump back into the right tmux pane. `agmux` records every session as it happens into a local-first store and gives you one place to **see, search, attach to, and manage** them — from the CLI, an interactive TUI, or a tmux popup.

**Status:** alpha (`v0.1.0-alpha.1`). The foundation (`protocol + store + hub + wrapper`), agent adapters (`claude`, `codex`, `pi`), and the `cli` + `tui` consumers are implemented. macOS-verified; Linux portability is best-effort and unverified in CI. Expect rough edges and breaking changes between alpha releases.

> **Heads-up — this project is heavily "vibed."** Nearly all code here is written by an AI coding agent. As a personal hobby project, I lean all the way into hands-off, agentic development as a field test of what current models produce with minimal human review. I stay hands-on for brainstorming, planning, and manual QA — but I barely read the code. So this does **not** reflect my professional standards for code quality or product design, and it shouldn't set that bar for you either. Don't expect that to change while it's in alpha. ;)

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
agmux run -p claude-work --new-window --prompt "review the diff"   # spawn elsewhere + bootstrap prompt
agmux run -p claude-work --headless --prompt "review the diff" > out.md  # one turn, no tmux, agent's exit code

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
`p` show/hide preview · `⏎` attach (switch-client) · `x` kill · `y` yank field ·
`u` mark read · `?` help · `q` quit.
Config under `[dash]` in `~/.config/agmux/config.toml`: `preview`, `interval`, `limit`, `status`, `sort`.

Each activity group (`f` cycles `open` → `closed` → `all`) runs its own hub query, so
`open` can stay cheap and fast while the terminal-heavy groups reach far back. Defaults:
`open` 50 rows every 1s, `closed`/`all` 1000 rows every 10s. Override per group — the
`[dash]` values are the fallback, and `-n/--limit/--all` or `-i/--interval` on the command
line override every group:

```toml
[dash]
interval = 1
limit = 50

[dash.closed]
limit = 2000
interval = 30
```

Run it inside tmux so `⏎` switches you to the agent's window while dash stays alive.

### Attention signals

`agmux notifyd` is a long-running daemon that watches sessions and drives two
surfaces: an always-visible tmux status line, and debounced notifications when a
session needs you. Start it once (e.g. from `~/.tmux.conf` or your shell profile):

```
agmux notifyd &
```

Configure it under `[notify]` and `[statusline]` in `~/.config/agmux/config.toml`.
All keys are optional; these are the defaults:

```toml
[notify]
enabled        = true
delay          = "5s"      # dwell before notifying; accepts "5s"/"2m"/a bare number
                            # of seconds. Unparseable values are a startup error, not
                            # a silent fallback to 0 (which would disable the debounce
                            # without telling anyone).
triggers       = ["permission", "prompt", "turn_end", "session_end"]
sound          = true
sound_name     = "Ping"    # macOS sound name; per-trigger override below
command        = "auto"    # auto | terminal-notifier | osascript | notify-send | <custom>
tmux_message   = true      # the in-tmux display-message toast
suppress_when_visible = true

[notify.sounds]            # optional per-trigger overrides, e.g.:
# permission  = "Sosumi"
# session_end = "Hero"

[statusline]
enabled  = true
position = "status2"       # status2 | status-right | off
show     = "all"           # all | unread | waiting
max      = 6               # max sessions rendered
format   = "{glyph} {tmux_session}:{tmux_window}"
sort     = "activity"      # started | activity
```

Notes:

- **`command = "auto"`** resolves at runtime, in order: `terminal-notifier`, then
  `osascript`, then `notify-send` — the first one found on `PATH` wins. Naming a
  notifier explicitly is exact, not a preference: if you set `command = "osascript"`
  and it isn't installed, notifications resolve to nothing rather than silently
  falling back to another notifier.
- **A custom `command`** is split on whitespace and run directly (no shell), with
  these placeholders substituted per token: `{title}`, `{body}`, `{session_id}`,
  `{sound}`. A placeholder not in that list is passed through unchanged — this is an
  intentional escape hatch, not an error — and a placeholder whose value is null
  (e.g. `{sound}` when `sound = false`) substitutes to an empty string.
- **Focus suppression is asymmetric, on purpose.** A visible pane (the session's
  `tmux_pane` is the active pane of an attached client) suppresses the in-tmux
  `display-message` toast, because you're already looking at it. It does **not**
  suppress the OS notification: tmux can tell which pane is active, but it cannot
  tell whether the terminal emulator itself has OS focus — a pane can be "active"
  while the terminal sits behind another window. The OS notification is exactly the
  signal that should still fire when you've tabbed away, so it always fires
  regardless of pane visibility.
- **`agmux notifyd` must be running for the status line to update.** `status-format`
  (or `status-right`) only `cat`s a cache file the daemon writes once per poll —
  it does not invoke `agmux` itself. Without the daemon running, the line goes
  stale; `agmux statusline --check` reports staleness explicitly rather than
  silently showing a frozen line.
- Exit code 0 from a notifier is never treated as proof a human saw anything
  (`osascript` returns 0 whether or not a banner was shown) — agmux does not retry
  and does not claim delivery.
- **`[statusline].enabled` and `[statusline].position` in `config.toml` are the
  defaults; the `@agmux-statusline` / `@agmux-statusline-position` tmux options
  are overrides.** At plugin load, `agmux.tmux` runs `agmux statusline
  --print-config` once to read the resolved config-file values and uses them
  wherever the corresponding tmux option is left unset; setting the tmux option
  explicitly always wins. Note that `[statusline].enabled` defaults to `true`,
  so if you leave `@agmux-statusline` unset the status line now turns on by
  default (a change from the previous opt-in-only behavior) — set
  `[statusline] enabled = false` or `@agmux-statusline off` to keep it off.

`agmux.tmux` options for the status line and mark-read key (set before the `run` line,
alongside the options in [tmux plugin (TPM)](#tmux-plugin-tpm) below):

| Option                       | Default   | Meaning                                                      |
| ---------------------------- | --------- | -------------------------------------------------------------|
| `@agmux-statusline`          | `[statusline].enabled` from `config.toml` (default `true`) | `on`/`off` overrides config.toml; changes your status bar |
| `@agmux-statusline-position` | `[statusline].position` from `config.toml` (default `status2`) | `status2` or `status-right`; overrides config.toml |
| `@agmux-statusline-interval` | `2`       | sets tmux's `status-interval`                                |
| `@agmux-statusline-mouse`    | `on`      | click a status-line entry to attach; opt-out because it installs a root-table `MouseDown1Status` binding |
| `@agmux-mark-read-key`       | `u`       | prefix key that marks the session owning the current pane read (`agmux seen --pane`) |

Multi-line status needs tmux ≥ 3.3. On 3.2 the status line falls back to
`status-right` automatically — the documented tmux floor stays at 3.2.

`agmux notifyd` must be running for the status line to update; `status-format`
only reads a cache file the daemon writes.

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
