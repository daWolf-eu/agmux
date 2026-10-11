#!/usr/bin/env bash
# N1 transparent view (spec §8.1, link-window variant — no session groups).
# usage: view.sh <socket-name> <target-pane>   e.g. view.sh spike work:0.0
set -eu
L="$1"; T="$2"
t() { tmux -L "$L" "$@"; }
W=$(t display -p -t "$T" '#{window_id}'); P=$(t display -p -t "$T" '#{pane_id}')
V="agmux-view-$(printf '%s' "$P$$" | md5sum | cut -c1-8)"
t new-session -d -s "$V"
t set -t "$V" status off \
  \; set -t "$V" prefix None \; set -t "$V" prefix2 None \
  \; set -t "$V" key-table agmux-view \; set -t "$V" mouse on
t bind -T agmux-view M-d detach-client
t link-window -s "$W" -t "$V:"
t kill-window -t "$V:^"
t select-pane -t "$P"
# destroy-unattached only now: set earlier, it fires on the never-attached
# session as soon as kill-window touches it (tmux 3.7c).
# -u: exec --tty passes no UTF-8 locale, without it the client draws "_" for non-ASCII.
exec tmux -u -L "$L" attach-session -t "$V" \; set -t "$V" destroy-unattached on
