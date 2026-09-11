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

agmux_tmux_statusline_target() {
  local requested="${1:-status2}" version="${2:-}"
  case "$requested" in
    off) printf 'off'; return ;;
    status-right) printf 'status-right'; return ;;
  esac
  if [ "$(agmux_tmux_supports_status2 "$version")" = "yes" ]; then printf 'status2'; else printf 'status-right'; fi
}

agmux_tmux_install_statusline() {
  local bin="$1" position="$2" interval="$3" mouse="$4"
  local cache="${XDG_RUNTIME_DIR:-$HOME/.cache}/agmux/statusline"
  [ -n "${XDG_RUNTIME_DIR:-}" ] || cache="$HOME/.cache/agmux/statusline"
  local target
  target="$(agmux_tmux_statusline_target "$position" "$(tmux -V)")"
  [ "$target" = "off" ] && return 0
  if [ "$target" = "status-right" ] && [ "$position" = "status2" ]; then
    tmux display-message "agmux: tmux $(tmux -V) has no multi-line status; using status-right"
  fi
  tmux set-option -g status-interval "$interval"
  if [ "$target" = "status2" ]; then
    tmux set-option -g status 2
    tmux set-option -g 'status-format[1]' "#(cat '$cache' 2>/dev/null)"
  else
    tmux set-option -g status-right "#(cat '$cache' 2>/dev/null)"
  fi
  if [ "$mouse" = "on" ]; then
    # An empty mouse_status_range means the click landed outside every range —
    # no-op rather than attaching to something arbitrary.
    tmux bind-key -T root MouseDown1Status run-shell \
      "if [ -n '#{mouse_status_range}' ]; then $bin attach '#{mouse_status_range}'; fi"
  fi
}

main() {
  local key bin width height extra
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

  statusline="$(tmux_get "@agmux-statusline" "off")"
  position="$(tmux_get "@agmux-statusline-position" "status2")"
  interval="$(tmux_get "@agmux-statusline-interval" "2")"
  mouse="$(tmux_get "@agmux-statusline-mouse" "on")"
  if [ "$statusline" = "on" ]; then
    agmux_tmux_install_statusline "$bin" "$position" "$interval" "$mouse"
  fi
}

[ -n "${AGMUX_TMUX_LIB_ONLY:-}" ] || main
