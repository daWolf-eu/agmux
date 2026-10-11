#!/usr/bin/env bash
# Stub "claude": fires the agmux claude hook points like the real plugin, then
# echoes every input byte as hex so key passthrough can be inspected.
set -u
SID="${STUB_SID:-$(cat /proc/sys/kernel/random/uuid)}"
export CLAUDE_CODE_SESSION_ID="$SID"
CWD="$PWD"
hook() { # $1 point, $2 json
  printf '%s' "$2" | AGMUX_AGENT_PID=$$ agmux emit --from=claude --source=hook-command --point="$1" >/dev/null 2>>/tmp/stub-emit.err
}
base="\"session_id\":\"$SID\",\"transcript_path\":\"/tmp/$SID.jsonl\",\"cwd\":\"$CWD\""
hook session.registered "{$base,\"hook_event_name\":\"SessionStart\",\"source\":\"startup\"}"
printf '%s' "{$base,\"hook_event_name\":\"SessionStart\",\"source\":\"startup\"}" | agmux emit --from=claude --attach >/dev/null 2>>/tmp/stub-emit.err
hook turn.started "{$base,\"hook_event_name\":\"UserPromptSubmit\",\"prompt\":\"hello from stub\"}"
hook prompt.sent "{$base,\"hook_event_name\":\"UserPromptSubmit\",\"prompt\":\"hello from stub\"}"
hook tool.used "{$base,\"hook_event_name\":\"PostToolUse\",\"tool_name\":\"Bash\"}"
hook turn.ended "{$base,\"hook_event_name\":\"Stop\"}"
echo "stub agent $SID pid $$ — type keys (q to quit)"
stty raw -echo 2>/dev/null; [ -n "${STUB_EXTKEYS:-}" ] && printf "\033[>4;2m"
while IFS= read -r -s -n1 -d '' c; do
  printf '%s' "$c" | od -An -tx1 | tr -d '\n'; printf '\r\n'
  [ "$c" = q ] && break
done
stty sane 2>/dev/null
