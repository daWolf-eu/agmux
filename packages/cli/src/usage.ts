// Single source of truth for the top-level `agmux` usage text. Printed to stdout
// (exit 0) for `agmux -h/--help/help`, and to stderr (exit 2) on a usage error.
// Kept here (not inline in the bin) so it can be asserted in tests.
export const HELP_TEXT = `usage: agmux <verb> [args]
  run [placement] [--wrapped] [--kind=<claude|codex|pi>] [--prompt <text>|--prompt-file <path>] <command> [args...]
  run [placement] [--wrapped] [--prompt <text>|--prompt-file <path>] -p <profile>
    --prompt <text>   the prompt to run (--prompt-file <path> reads it from a file).
                      Requires a placement: injected into the new pane after spawn,
                      or run as the single turn under --headless.
    --headless        run the prompt non-interactively: no tmux, no PTY, agent
                      stdout streamed on stdout, exits with the agent's exit code.
                      Requires --prompt/--prompt-file; claude and codex only.
                        agmux run -p work --headless --prompt "..." > out.md
                      Still a first-class session: it records, and agmux attach
                      relaunches it interactively afterwards.
    placement: --headless | --new-pane | --new-window | --new-session (default: inherit current pane; -d/--detach implies --new-pane)
    --wrapped   force the PTY wrapper (default: direct exec when the agent has an adapter)
  ls [-n <num>|--all] [--sort <started|activity>] [--asc|--desc] [-r/--reverse]
     [--status <active|open|closed|s1,s2,...>] [--live] [--agent <kind>] [--profile <name>]
     defaults configurable in ~/.config/agmux/config.toml under [ls]
  watch [ls flags] [-i/--interval <seconds>]
     fullscreen live view of ls (defaults: --status open --sort started); q quits
  dash [ls flags] [-i/--interval <seconds>] [--preview <mirror|detail>]
     interactive TUI: grouped sessions + preview; ⏎ attach, x kill, r resume, q quit
     each activity group (f) polls on its own: open 50 rows/1s, closed+all 1000/10s
     ([dash], [dash.open], [dash.closed], [dash.all] in config; -n/-i override all)
  attach <id|prefix>
  seen <id|prefix>|--pane <pane_id> [--socket <tmux socket>] [--source focus]
     marks a session seen (session.seen): a done session becomes idle.
     --pane resolves the tmux pane owning it and is silently a no-op unless an
     open session owns that pane and is done (agmux.tmux runs this from the
     pane-focus-in hook with --source focus)
  explain <id|prefix>|--pane <pane_id> [--json]
     why a session shows its status: the rule that decided it, the event that
     set it, attention vs seen timestamps, the title signal
  statusline [--check|--print-config]
     render the tmux status line once and exit, reading from the hub;
     --check instead reads notifyd's cache file and reports staleness;
     --print-config prints the resolved [statusline] config.toml defaults
     (enabled=, position=) for agmux.tmux to use as fallbacks; never fails
  notifyd
     long-running daemon: writes the status-line cache file and fires
     debounced, focus-aware notifications; must be running for the tmux
     status line to update
  kill <id|prefix> [--signal SIGTERM]
  inspect <id|prefix>
  adapter list|install|status|uninstall (<profile> | --kind <agent_kind>) [--config-dir <path>]
  hub status|restart       inspect / gracefully roll the background hub
  -h, --help               print this help
  -v, --version            print agmux + adapter versions`;
