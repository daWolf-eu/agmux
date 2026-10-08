#!/usr/bin/env bash
# agmux tmux plugin (TPM entry).
# Binds a key (default prefix+g) to open `agmux dash` in a tmux popup.
# Options (set before `run '~/.tmux/plugins/tpm/tpm'`):
#   @agmux-key           key under the prefix table (default: g)
#   @agmux-bin           agmux binary (default: agmux; use an absolute path
#                        if agmux is not on tmux's PATH)
#   @agmux-popup-width   popup width  (default: 80%)
#   @agmux-popup-height  popup height (default: 80%)
#   @agmux-dash-args     extra args appended to `agmux dash --popup`
#   @agmux-mark-read-key key under the prefix table that marks the session
#                        owning the current pane seen (default: u)
#   @agmux-statusline-position status2|inline|status-right|off — inline sets
#                        @agmux-chips only; place #{E:@agmux-chips} yourself.
#                        Styling: @agmux-statusline-* (see README "Styling").
#   @agmux-seen-on-focus on|off — a pane gaining focus (any route: prefix keys,
#                        mouse, choose-tree, terminal focus) marks the session
#                        it hosts seen, turning `done` into `idle` (default: on).
#                        Turns on the global focus-events option.
set -euo pipefail

tmux_get() {
  local val
  val="$(tmux show-option -gqv "$1")"
  if [ -z "$val" ]; then printf '%s' "$2"; else printf '%s' "$val"; fi
}

# Multi-line status (status-format[1]) landed in tmux 3.3. Below that we degrade
# to status-right, which is a graceful downgrade, not a broken feature — so the
# documented floor stays at 3.2.
agmux_tmux_supports_status2() {
  local v="${1:-}" major minor
  v="${v#tmux }"
  major="${v%%.*}"
  minor="${v#*.}"
  minor="${minor%%[!0-9]*}"
  [ -z "$minor" ] && minor=0
  if [ "$major" -gt 3 ] 2>/dev/null; then printf 'yes'; return; fi
  if [ "$major" -eq 3 ] 2>/dev/null && [ "$minor" -ge 3 ] 2>/dev/null; then printf 'yes'; return; fi
  printf 'no'
}

# Asks the binary for the resolved [statusline] config.toml defaults, once at
# plugin load. `agmux statusline --print-config` is documented to always exit
# 0 and print `enabled=...` / `position=...` lines, even with no config file,
# an unreadable one, or one with an invalid value. We still guard the call:
# under `set -euo pipefail` a failing command substitution (missing binary,
# unexpected crash) would otherwise kill the user's whole tmux config load, so
# a failure here must fall back to the hardcoded defaults instead of aborting.
agmux_tmux_config_defaults() {
  local bin="$1" out enabled="off" position="status2"
  if out="$("$bin" statusline --print-config 2>/dev/null)"; then
    local line key val
    while IFS= read -r line; do
      key="${line%%=*}"
      val="${line#*=}"
      case "$key" in
        enabled) [ "$val" = "true" ] && enabled="on" || enabled="off" ;;
        position) [ -n "$val" ] && position="$val" ;;
      esac
    done <<EOF
$out
EOF
  fi
  printf '%s\n%s\n' "$enabled" "$position"
}

agmux_tmux_statusline_target() {
  local requested="${1:-status2}" version="${2:-}"
  case "$requested" in
    off) printf 'off'; return ;;
    inline) printf 'inline'; return ;;
    status-right) printf 'status-right'; return ;;
  esac
  if [ "$(agmux_tmux_supports_status2 "$version")" = "yes" ]; then printf 'status2'; else printf 'status-right'; fi
}

agmux_tmux_install_statusline() {
  local bin="$1" position="$2" interval="$3" mouse="$4" version="${5:-}"
  local cache
  if [ -n "${XDG_RUNTIME_DIR:-}" ]; then
    cache="${XDG_RUNTIME_DIR}/agmux/statusline"
  else
    cache="${HOME:-/tmp}/.cache/agmux/statusline"
  fi
  [ -z "$version" ] && version="$(tmux -V)"
  local target
  target="$(agmux_tmux_statusline_target "$position" "$version")"
  [ "$target" = "off" ] && return 0
  if [ "$target" = "status-right" ] && [ "$position" = "status2" ]; then
    tmux display-message "agmux: tmux $(tmux -V) has no multi-line status; using status-right"
  fi
  tmux set-option -g status-interval "$interval"
  # The line, for any status format: `#{E:@agmux-chips}`. `inline` stops here
  # and leaves placing it to the user's own status-left/right.
  tmux set-option -g @agmux-chips "#(cat '$cache' 2>/dev/null)"
  if [ "$target" = "status2" ]; then
    tmux set-option -g status 2
    tmux set-option -g 'status-format[1]' "#{E:@agmux-chips}"
  elif [ "$target" = "status-right" ]; then
    tmux set-option -g status-right "#{E:@agmux-chips}"
  fi
  if [ "$mouse" = "on" ]; then
    agmux_tmux_bind_click "$bin" MouseDown1Status left
    agmux_tmux_bind_click "$bin" MouseDown3Status right
  fi
}

# The command a root-table mouse key ran before we took it over, so a click
# outside our chips (the window list, tmux's right-click menu) keeps doing what
# it did. Remembered in @agmux-orig-<key> the first time, so re-sourcing the
# plugin never wraps our own binding. A binding from an older agmux (it read
# #{mouse_status_range} unconditionally, on MouseDown1Status only) is replaced
# by tmux's built-in default for that key.
agmux_tmux_orig_binding() {
  local key="$1" opt="@agmux-orig-$1" orig
  orig="$(tmux show-option -gqv "$opt")"
  if [ -z "$orig" ]; then
    orig="$(tmux list-keys -T root "$key" 2>/dev/null | agmux_tmux_binding_cmd "$key" || true)"
    case "$orig" in *mouse_status_range*) orig="$(agmux_tmux_default_binding "$key" || true)" ;; esac
    if [ -n "$orig" ]; then tmux set-option -g "$opt" "$orig"; fi
  fi
  printf '%s' "$orig"
}

# `bind-key -T root <key> <command>` lines on stdin → the command. Callers
# guard with `|| true`: under pipefail an unbound key fails the pipeline.
agmux_tmux_binding_cmd() {
  head -n 1 | sed -E "s/^bind-key +(-r +)?-T +root +$1 +//"
}

# tmux's own default for a root-table key, which differs between versions
# (`select-window -t =` vs `switch-client -t =`): asked of a throwaway server
# started without any config, which exits again right away.
agmux_tmux_default_binding() {
  tmux -L "agmux-defaults-$$" -f /dev/null start-server \; list-keys -T root "$1" 2>/dev/null \
    | agmux_tmux_binding_cmd "$1"
}

# Chips are `range=user|@…` (see tui/src/shared/statusline.ts): a click on one
# goes to `agmux statusline --click`, in the background so tmux never waits on
# Bun, then repaints the clicking client's status line (the filter chip changes
# it at once); any other click runs the original binding.
agmux_tmux_bind_click() {
  local bin="$1" key="$2" button="$3" orig ours
  orig="$(agmux_tmux_orig_binding "$key")"
  ours="run-shell -b \"'$bin' statusline --click $button '#{mouse_status_range}'; tmux refresh-client -S -t '#{client_name}'\""
  if [ -n "$orig" ]; then
    tmux bind-key -T root "$key" if-shell -F '#{m:@*,#{mouse_status_range}}' "$ours" "$orig"
  else
    tmux bind-key -T root "$key" if-shell -F '#{m:@*,#{mouse_status_range}}' "$ours"
  fi
}

# Seen = you reached the pane, by whatever route. pane-focus-in needs
# focus-events; with it tmux also fires the hook when the terminal window itself
# regains focus. Index [99] namespaces our hook so a user's own pane-focus-in
# hooks are left alone, and -b keeps pane switches instant (the agmux process
# runs in the background; it is a no-op unless that pane's session is `done`).
agmux_tmux_install_focus_seen() {
  local bin="$1"
  tmux set-option -g focus-events on
  tmux set-hook -g 'pane-focus-in[99]' \
    "run-shell -b \"'$bin' seen --pane '#{pane_id}' --socket '#{socket_path}' --source focus\""
}

main() {
  local key bin width height extra mark_key
  key="$(tmux_get "@agmux-key" "g")"
  bin="$(tmux_get "@agmux-bin" "agmux")"
  width="$(tmux_get "@agmux-popup-width" "80%")"
  height="$(tmux_get "@agmux-popup-height" "80%")"
  extra="$(tmux_get "@agmux-dash-args" "")"

  # Non-blocking warning if the key is already bound under the prefix table.
  # `list-keys -T prefix <key>` matches the exact key (no regex), so keys with
  # special characters are handled correctly.
  if [ -n "$(tmux list-keys -T prefix "$key" 2>/dev/null)" ]; then
    tmux display-message "agmux: prefix+${key} was already bound; overriding (set @agmux-key to change)"
  fi

  tmux bind-key "$key" display-popup -E -w "$width" -h "$height" "$bin dash --popup${extra:+ $extra}"

  mark_key="$(tmux_get "@agmux-mark-read-key" "u")"
  tmux bind-key "$mark_key" run-shell "'$bin' seen --pane '#{pane_id}' --socket '#{socket_path}'"

  if [ "$(tmux_get "@agmux-seen-on-focus" "on")" = "on" ]; then
    agmux_tmux_install_focus_seen "$bin"
  fi

  # config.toml's [statusline] enabled/position are the defaults; an explicitly
  # set @agmux-statusline / @agmux-statusline-position tmux option overrides
  # them. tmux_get already returns "" only when unset (never when set to an
  # empty string is meaningful here), so a plain default-substitution can't
  # tell "unset" from "set to the same value as the default" — we ask tmux
  # show-option directly instead, and only fall back to the config-derived
  # default when the option is genuinely unset.
  local cfg_defaults cfg_enabled cfg_position statusline_raw position_raw
  cfg_defaults="$(agmux_tmux_config_defaults "$bin")"
  cfg_enabled="${cfg_defaults%%$'\n'*}"
  cfg_position="${cfg_defaults#*$'\n'}"

  statusline_raw="$(tmux show-option -gqv "@agmux-statusline")"
  if [ -n "$statusline_raw" ]; then statusline="$statusline_raw"; else statusline="$cfg_enabled"; fi

  position_raw="$(tmux show-option -gqv "@agmux-statusline-position")"
  if [ -n "$position_raw" ]; then position="$position_raw"; else position="$cfg_position"; fi

  interval="$(tmux_get "@agmux-statusline-interval" "2")"
  mouse="$(tmux_get "@agmux-statusline-mouse" "on")"
  if [ "$statusline" = "on" ]; then
    agmux_tmux_install_statusline "$bin" "$position" "$interval" "$mouse" "$(tmux -V)"
  fi
}

[ -n "${AGMUX_TMUX_LIB_ONLY:-}" ] || main
