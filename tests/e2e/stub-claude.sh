#!/bin/sh
# Stand-in for `claude` in the remote e2e: fires the agmux Claude plugin's hooks the way claude
# does (`${AGMUX_BIN:-agmux} emit --from=claude …`, CLAUDE_CODE_SESSION_ID in the env, the hook
# JSON on stdin), so a direct launch registers natively.
#   <args…>             → session.registered under a fresh native id, one turn (turn.started,
#                         turn.ended: natively resumable), then a `❯ ` prompt reading lines
#   --resume <id> …     → the same under <id>
#   … -p <prompt>       → headless: prints <prompt>, exits 3, no hooks
# Each non-empty line read is appended to $HOME/stub-claude.prompts (C-a/C-k, the injector's
# pre-clear, stripped); `/exit` exits 0. Every launch appends its argv to
# $HOME/stub-claude.argv, tab-joined, one line per launch.
tab=$(printf '\t')
(sep=; for a in "$@"; do printf '%s%s' "$sep" "$a"; sep=$tab; done | tr '\n' ' '; echo) >> "$HOME/stub-claude.argv"

sid=""
prev=""
for a in "$@"; do
  [ "$prev" = "-p" ] && { printf '%s\n' "$a"; exit 3; }
  [ "$prev" = "--resume" ] && sid=$a
  prev=$a
done
[ -n "$sid" ] || sid="stub-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"

hook() {
  printf '{"session_id":"%s","cwd":"%s"}' "$sid" "$PWD" |
    CLAUDE_CODE_SESSION_ID=$sid AGMUX_AGENT_PID=$$ "${AGMUX_BIN:-agmux}" emit --from=claude --source=hook-command --point="$1"
}
hook session.registered
hook turn.started
hook turn.ended

# Like claude's input box: a line stays on the `❯` line until an empty Enter submits it.
printf '❯ '
while IFS= read -r line; do
  line=$(printf '%s' "$line" | tr -d '\001\013')
  [ "$line" = "/exit" ] && exit 0
  if [ -z "$line" ]; then printf '❯ '; else printf '%s\n' "$line" >> "$HOME/stub-claude.prompts"; fi
done
