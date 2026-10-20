#!/usr/bin/env bash
# Stub "claude" for the phase 1 smoke test: registers like the real plugin, then
# runs one turn (prompt, tool, stop) every STUB_INTERVAL seconds until killed,
# so the Mac sees a steady event flow over hours.
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
n=0
while :; do
  n=$((n + 1))
  hook turn.started "{$base,\"hook_event_name\":\"UserPromptSubmit\",\"prompt\":\"turn $n\"}"
  hook tool.used "{$base,\"hook_event_name\":\"PostToolUse\",\"tool_name\":\"Bash\"}"
  hook turn.ended "{$base,\"hook_event_name\":\"Stop\"}"
  echo "$(date -u +%FT%TZ) turn $n"
  sleep "${STUB_INTERVAL:-20}"
done
