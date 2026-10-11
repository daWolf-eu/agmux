#!/usr/bin/env bash
# Manual N1 check in a real terminal (Ghostty). Starts a fresh stub agent on an
# isolated tmux server in the sandbox and opens the transparent view on it.
# usage: n1-manual.sh [gateway] [sandbox] [agent-cmd]
#   agent-cmd defaults to the stub (prints received bytes as hex); pass
#   'claude' to check a real agent once it is logged in.
set -eu
GW="${1:-ai-sandbox}"; SBX="${2:-wi-sag-280}"; AGENT="${3:-\$HOME/.spike/stub-agent.sh}"
openshell -g "$GW" sandbox exec -n "$SBX" --no-tty -- bash -lc "
  export PATH=/sandbox/.spike/bin/x64:\$PATH
  tmux -L spike has-session -t keepalive 2>/dev/null || tmux -L spike -f /dev/null new-session -d -s keepalive 'sleep 86400'
  tmux -L spike set -s escape-time 0 \; set -s extended-keys on \; set -as terminal-features ',xterm*:extkeys'
  tmux -L spike kill-session -t manual 2>/dev/null || true
  cd ~/sag && tmux -L spike new-session -d -s manual -x 200 -y 50 -e PATH=\$PATH -e STUB_EXTKEYS=1 \"$AGENT\"" </dev/null
exec openshell -g "$GW" sandbox exec -n "$SBX" --tty -- bash -lc '$HOME/.spike/view.sh spike manual:0.0'
