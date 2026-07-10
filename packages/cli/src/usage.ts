// Single source of truth for the top-level `agmux` usage text. Printed to stdout
// (exit 0) for `agmux -h/--help/help`, and to stderr (exit 2) on a usage error.
// Kept here (not inline in the bin) so it can be asserted in tests.
export const HELP_TEXT = `usage: agmux <verb> [args]
  run [placement] [--wrapped] [--kind=<claude|codex|pi>] [--prompt <text>|--prompt-file <path>] <command> [args...]
  run [placement] [--wrapped] [--prompt <text>|--prompt-file <path>] -p <profile>
    --prompt <text>   inject a bootstrap prompt after spawn (requires --new-pane/--new-window/--new-session)
    placement: --new-pane | --new-window | --new-session (default: inherit current pane; -d/--detach implies --new-pane)
    --wrapped   force the PTY wrapper (default: direct exec when the agent has an adapter)
  ls [-n <num>|--all] [--sort <started|activity>] [--asc|--desc] [-r/--reverse]
     [--status <active|open|closed|s1,s2,...>] [--live] [--agent <kind>] [--profile <name>]
     defaults configurable in ~/.config/agmux/config.toml under [ls]
  watch [ls flags] [-i/--interval <seconds>]
     fullscreen live view of ls (defaults: --status open --sort started); q quits
  dash [ls flags] [-i/--interval <seconds>] [--preview <mirror|detail>]
     interactive TUI: grouped sessions + preview; ⏎ attach, x kill, r resume, q quit
  attach <id|prefix>
  kill <id|prefix> [--signal SIGTERM]
  inspect <id|prefix>
  adapter list|install|status|uninstall (<profile> | --kind <agent_kind>) [--config-dir <path>]
  hub status|restart       inspect / gracefully roll the background hub
  -h, --help               print this help
  -v, --version            print agmux + adapter versions`;
