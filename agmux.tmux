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
}

main
