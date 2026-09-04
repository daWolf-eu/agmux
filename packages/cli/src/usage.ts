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
  kill <id|prefix> [--signal SIGTERM]
  inspect <id|prefix>
  adapter list|install|status|uninstall (<profile> | --kind <agent_kind>) [--config-dir <path>]
  hub status|restart       inspect / gracefully roll the background hub
  -h, --help               print this help
  -v, --version            print agmux + adapter versions`;
