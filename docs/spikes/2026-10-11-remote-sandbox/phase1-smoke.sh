#!/usr/bin/env bash
# Phase 1 smoke test against a real OpenShell gateway, without any image change:
# binaries are uploaded, the Mac side runs an isolated hub under a temp HOME, so
# the developer's own hub, config and status line are untouched.
#
#   IMAGE=openshell-workbench:e797e53b7f50 docs/spikes/2026-10-11-remote-sandbox/phase1-smoke.sh setup
#   … then: check | teardown
#
#   IMAGE=openshell-workbench:<tag> docs/spikes/2026-10-11-remote-sandbox/phase1-smoke.sh phase2
#   Phase 2 (remote attach), self-contained: creates SBX (default agmux-p2-smoke), runs
#   the checks, deletes it again (only if this run created it). Refuses any GW but
#   ai-sandbox, any SBX but agmux-p2-*, and an SBX that already exists. Uses the
#   image's agmux and tmux as they are.
#
# OS: the openshell client to use (default: openshell on PATH). It must be
# compatible with the gateway; no particular version is required.
set -euo pipefail
REPO=$(cd "$(dirname "$0")/../../.." && pwd)
GW=${GW:-ai-sandbox}
[ "${1:-}" = phase2 ] && SBX=${SBX:-agmux-p2-smoke}
SBX=${SBX:-agmux-smoke}
OS=${OS:-openshell}
IMAGE=${IMAGE:?set IMAGE to the workbench image tag on the gateway host}
[ -z "${WORK:-}" ] && WORK_MADE=1
WORK=${WORK:-$(mktemp -d -t agmux-smoke)}
M=$WORK/mac

os() { "$M/bin/openshell" -g "$GW" "$@"; }
x() { os sandbox exec -n "$SBX" --no-tty -- "$@" </dev/null; }

setup() {
  mkdir -p "$WORK/bin" "$M/bin" "$M/.agmux" "$M/.config/agmux"
  (cd "$REPO" && bun install --os='*' --cpu='*' >/dev/null &&
    bun build --compile --target=bun-linux-x64 packages/cli/bin/agmux.ts --outfile "$WORK/bin/agmux" &&
    bun build --compile --target=bun-linux-x64 packages/hub/bin/agmux-hub.ts --outfile "$WORK/bin/agmux-hub")

  # Mac side: openshell with the real HOME (gateway credentials), agmux under the temp HOME.
  printf '#!/bin/sh\nunset XDG_CONFIG_HOME\nHOME=%s exec %s "$@"\n' "$HOME" "$(command -v "$OS")" > "$M/bin/openshell"
  for b in agmux:cli/bin/agmux.ts agmux-hub:hub/bin/agmux-hub.ts; do
    printf '#!/bin/sh\nexport HOME=%s XDG_CONFIG_HOME=%s/.config AGMUX_HUB_BIN=%s/bin/agmux-hub\nexec bun %s/packages/%s "$@"\n' \
      "$M" "$M" "$M" "$REPO" "${b#*:}" > "$M/bin/${b%%:*}"
  done
  chmod +x "$M"/bin/*
  cat > "$M/.config/agmux/config.toml" <<EOF
[[remote]]
name = "$GW"
gateway = "$GW"
interval = 5
openshell_bin = "$M/bin/openshell"
agmux_bin = "/sandbox/.agmux-bin/agmux-remote"
EOF

  # Sandbox: created with the label and AGMUX_HOST, as the launcher will do it.
  cat > "$WORK/policy.yaml" <<'EOF'
version: 1
filesystem_policy:
  include_workdir: true
  read_only: [/usr, /lib, /proc, /dev/urandom, /etc, /var/log]
  read_write: [/sandbox, /tmp, /dev/null, /dev/pts]
landlock:
  compatibility: hard_requirement
process:
  run_as_user: sandbox
  run_as_group: sandbox
EOF
  (timeout 90 "$M/bin/openshell" -g "$GW" sandbox create --name "$SBX" --from "$IMAGE" --policy "$WORK/policy.yaml" \
    --label agmux=1 --env "AGMUX_HOST=$GW/$SBX" -- sleep infinity </dev/null >"$WORK/create.log" 2>&1 &)
  until [ "$(os sandbox get "$SBX" -o json 2>/dev/null | python3 -c 'import json,sys;print(json.load(sys.stdin)["phase"])' 2>/dev/null)" = Ready ]; do sleep 2; done
  printf '#!/bin/sh\nexport PATH=/sandbox/.agmux-bin:$PATH\nexec /sandbox/.agmux-bin/agmux "$@"\n' > "$WORK/bin/agmux-remote"
  chmod +x "$WORK/bin/agmux-remote"
  x mkdir -p /sandbox/.agmux-bin
  for f in "$WORK/bin/agmux" "$WORK/bin/agmux-hub" "$WORK/bin/agmux-remote" "$REPO/docs/spikes/2026-10-11-remote-sandbox/stub-agent-loop.sh"; do
    os sandbox upload "$SBX" "$f" /sandbox/.agmux-bin/ >/dev/null
  done
  x bash -lc 'export PATH=/sandbox/.agmux-bin:$PATH; cd /sandbox; agmux ls >/dev/null; tmux new-session -d -s work "PATH=/sandbox/.agmux-bin:\$PATH bash /sandbox/.agmux-bin/stub-agent-loop.sh"'

  (nohup "$M/bin/agmux-hub" >"$M/hub.log" 2>&1 &)
  echo "WORK=$WORK"
}

check() {
  until "$M/bin/agmux" ls --remote | grep -q claude; do sleep 1; done
  "$M/bin/agmux" ls --remote
  "$M/bin/agmux" hub status
  id=$("$M/bin/agmux" ls --remote | awk 'NR==2{print $1}')
  "$M/bin/agmux" kill "$id" || echo "kill refused (rc=$?)"
  "$M/bin/agmux" attach "$id" || echo "attach refused (rc=$?)"
}

teardown() {
  [ -f "$M/.agmux/hub.pid" ] && kill "$(cat "$M/.agmux/hub.pid")" 2>/dev/null || true
  os sandbox delete "$SBX" || true
}


# ---- Phase 2: remote attach -------------------------------------------------
# Mac side: an isolated hub (this checkout, temp HOME) and an isolated "outer"
# tmux server (own socket, -f /dev/null) with a control-mode client standing in
# for the terminal. The openshell wrapper logs every call (epoch ms, argv, the
# scripts as <script>) to $M/calls.log, so the reap exec can be seen.
S=$WORK/outer.sock
T() { tmux -u -f /dev/null -S "$S" "$@"; }
ms() { perl -MTime::HiRes=time -e 'printf "%d", time*1000'; }
ok() { echo "ok   $*"; }
bad() { echo "FAIL $*"; FAILS=$((FAILS + 1)); }
FAILS=0
# wait_for <seconds> <cmd…>: poll until cmd succeeds.
wait_for() { local end=$(($(date +%s) + $1)); shift; until "$@"; do [ "$(date +%s)" -ge "$end" ] && return 1; sleep 0.2; done; }
has() { case $("${@:2}" 2>/dev/null) in *"$1"*) return 0 ;; esac; return 1; } # has <text> <cmd…>
lacks() { ! has "$@"; }
calls_since() { tail -n +"$(($1 + 1))" "$M/calls.log" | grep -v 'sandbox list'; }

p2_setup() {
  mkdir -p "$M/bin" "$M/.agmux" "$M/.config/agmux"
  cat > "$M/bin/openshell" <<W
#!/bin/sh
line=\$(perl -MTime::HiRes=time -e 'printf "%d", time*1000')
for a in "\$@"; do case \$a in *'
'*) a='<script>' ;; esac; line="\$line \$a"; done
printf '%s\n' "\$line" >> $M/calls.log
unset XDG_CONFIG_HOME
HOME=$HOME exec $(command -v "$OS") "\$@"
W
  for b in agmux:cli/bin/agmux.ts agmux-hub:hub/bin/agmux-hub.ts; do
    printf '#!/bin/sh\nexport HOME=%s XDG_CONFIG_HOME=%s/.config AGMUX_HUB_BIN=%s/bin/agmux-hub\nexec bun %s/packages/%s "$@"\n' \
      "$M" "$M" "$M" "$REPO" "${b#*:}" > "$M/bin/${b%%:*}"
  done
  chmod +x "$M"/bin/*
  # Default agmux_bin: the attach scripts need only sh + tmux, the follower the image's agmux.
  printf '[[remote]]\nname = "%s"\ngateway = "%s"\ninterval = 5\nopenshell_bin = "%s"\n' "$GW" "$GW" "$M/bin/openshell" \
    > "$M/.config/agmux/config.toml"
  cat > "$WORK/policy.yaml" <<'P'
version: 1
filesystem_policy:
  include_workdir: true
  read_only: [/usr, /lib, /proc, /dev/urandom, /etc, /var/log]
  read_write: [/sandbox, /tmp, /dev/null, /dev/pts]
landlock:
  compatibility: hard_requirement
process:
  run_as_user: sandbox
  run_as_group: sandbox
P
  (timeout 90 "$M/bin/openshell" -g "$GW" sandbox create --name "$SBX" --from "$IMAGE" --policy "$WORK/policy.yaml" \
    --label agmux=1 --env "AGMUX_HOST=$GW/$SBX" -- sleep infinity </dev/null >"$WORK/create.log" 2>&1 &)
  # Ours only once create says so: a failed create must never lead to a delete.
  if ! wait_for 120 has "Created sandbox: $SBX" cat "$WORK/create.log"; then
    echo "FAIL create not confirmed (not deleting; check sandbox list):"; cat "$WORK/create.log"; return 1
  fi
  CREATED=1
  wait_for 120 phase_is Ready || { echo "sandbox not Ready"; return 1; }
  x mkdir -p /sandbox/.agmux-p2
  os sandbox upload "$SBX" "$REPO/docs/spikes/2026-10-11-remote-sandbox/stub-agent-loop.sh" /sandbox/.agmux-p2/ >/dev/null 2>&1
  start_stub
  (nohup "$M/bin/agmux-hub" >"$M/hub.log" 2>&1 &)

  OENV=(HOME="$M" XDG_CONFIG_HOME="$M/.config" AGMUX_HUB_BIN="$M/bin/agmux-hub" AGMUX_BIN="$M/bin/agmux"
    PATH="$M/bin:$(dirname "$(command -v tmux)"):$(dirname "$(command -v bun)"):/usr/bin:/bin:/usr/sbin:/sbin"
    TERM=xterm-256color LANG=en_US.UTF-8)
  env -i "${OENV[@]}" tmux -u -f /dev/null -S "$S" new-session -d -s mac -x 160 -y 45 "sleep 100000" \
    \; set -g default-terminal xterm-256color
  (env -i "${OENV[@]}" sh -c "sh -c 'echo \$\$ > $WORK/ctl.pid; exec sleep 100000' | exec tmux -u -f /dev/null -S '$S' -C attach-session -t mac >/dev/null 2>&1" &)
  wait_for 5 has mac T list-clients
  read -r OPID OPANE <<<"$(T display -p -t mac '#{pid} #{pane_id}')"
}

phase_is() { [ "$(os sandbox get "$SBX" -o json 2>/dev/null </dev/null | python3 -c 'import json,sys;print(json.load(sys.stdin)["phase"])' 2>/dev/null)" = "$1" ]; }
# The agent: stub-agent-loop.sh in tmux session `work` (image agmux and tmux, on the exec PATH).
start_stub() { x sh -c 'cd /sandbox; agmux ls >/dev/null 2>&1; tmux new-session -d -s work "STUB_INTERVAL=10 bash /sandbox/.agmux-p2/stub-agent-loop.sh"'; }
live_id() { local i; i=$("$M/bin/agmux" ls --remote 2>/dev/null | awk 'NR>1 && /claude/ && !/lost/{print $1; exit}'); [ -n "$i" ] && echo "$i"; }
# new_id <old id as ls prints it>: id8 alone is not enough, UUIDv7 ids share it for ~65 s.
new_id() { local i; i=$("$M/bin/agmux" ls --remote 2>/dev/null | awk -v o="$1" 'NR>1 && /claude/ && !/lost/ && $1 != o {print $1; exit}'); [ -n "$i" ] && echo "$i"; }
full_id() { "$M/bin/agmux" inspect "$1" | python3 -c 'import json,sys;print(json.load(sys.stdin)["session"]["session_id"])'; }
has_coords() { "$M/bin/agmux" inspect "$1" 2>/dev/null | python3 -c 'import json,sys;s=json.load(sys.stdin)["session"];sys.exit(0 if s["remote_tmux"] else 1)'; }
# attach <mode>: as if typed in the `mac` pane; sets PANE/WIN/TAG of the new local window.
attach_as_user() {
  env -i "${OENV[@]}" TMUX="$S,$OPID,0" TMUX_PANE="$OPANE" "$M/bin/agmux" attach "$ID" --placement new-window --mode "$1" || return
  wait_for 10 pane_of_id || return
  WIN=$(T display -p -t "$PANE" '#{window_id}'); TAG=p${PANE#%}
}
pane_of_id() { PANE=$(T list-panes -a -F '#{pane_id} #{@agmux_session_id}' | awk -v id="$ID" '$2==id{print $1; exit}'); [ -n "$PANE" ]; }
rtmux() { x tmux "$@"; }
win_open() { has "$WIN " T list-windows -a -F '#{window_id} '; }

phase2_checks() {
  local t0 n0 id8 view pid c
  set +e +o pipefail # a failing check is reported, it does not abort the run
  # 1. replication of the coords
  wait_for 60 live_id >/dev/null || { bad "1 session in ls --remote"; return; }
  ID=$(full_id "$(live_id)"); id8=${ID:0:8}
  if wait_for 30 has_coords "$ID"; then ok "1 ls --remote + inspect .session.remote_tmux: $("$M/bin/agmux" inspect "$ID" | python3 -c 'import json,sys;print(json.load(sys.stdin)["session"]["remote_tmux"])')"
  else bad "1 remote_tmux on $ID"; fi

  # 2. view: visible, M-d closes without hold, no agmux-view-* left
  t0=$(ms); attach_as_user view || { bad "2 view attach"; return; }
  view=agmux-view-$id8-$TAG
  if wait_for 15 has turn T capture-pane -p -t "$PANE"; then ok "2 view: agent output in the local pane after $(($(ms) - t0)) ms"; else bad "2 view output"; fi
  [ "$(T show -pv -t "$PANE" @agmux_attach_mode)" = view ] && ok "2 pane options @agmux_remote=$(T show -pv -t "$PANE" @agmux_remote) mode=view" || bad "2 pane options"
  has "$view: 1 windows" rtmux ls && ok "2 sandbox has $view" || bad "2 $view missing"
  t0=$(ms); T send-keys -t "$PANE" M-d
  if wait_for 10 lacks "$WIN " T list-windows -a -F '#{window_id} '; then ok "2 M-d closed the window after $(($(ms) - t0)) ms (no hold)"; else bad "2 M-d"; fi
  lacks agmux-view rtmux ls && ok "2 no agmux-view-* in the sandbox" || bad "2 agmux-view-* left"

  # 3. hangup reap: kill-window locally, the view is gone within 5 s, the reap exec ran
  attach_as_user view && view=agmux-view-$id8-$TAG && wait_for 15 has "$view" rtmux list-clients || { bad "3 view attach"; return; }
  n0=$(wc -l <"$M/calls.log"); t0=$(ms); T kill-window -t "$WIN"
  if wait_for 5 lacks agmux-view rtmux ls; then ok "3 view gone $(($(ms) - t0)) ms after kill-window"; else bad "3 view still there after 5 s"; fi
  c=$(calls_since "$n0" | grep -- "--no-tty -- sh -c <script> agmux $TAG\$" | head -1)
  [ -n "$c" ] && ok "3 reap exec ran at +$((${c%% *} - t0)) ms: ${c#* }" || bad "3 no reap exec"

  # 3b. control: the pane process SIGKILLed (no reap), then kill-window. Shows what
  # openshell itself does with the remote side of a --tty exec whose client is gone.
  attach_as_user view && wait_for 15 has "agmux-view-$id8-$TAG" rtmux list-clients || { bad "3b view attach"; return; }
  pid=$(pgrep -P "$(T display -p -t "$PANE" '#{pane_pid}')" bun); kill -KILL "$pid"; sleep 0.3
  n0=$(wc -l <"$M/calls.log"); t0=$(ms); T kill-window -t "$WIN"
  if wait_for 10 lacks agmux-view rtmux ls; then echo "info 3b without reap: remote view gone after $(($(ms) - t0)) ms (openshell tore the remote pty down)"
  else echo "info 3b without reap: remote view still there after 10 s (openshell leaves the remote side)"; x sh -c 'tmux kill-session -t "=$1"' agmux "agmux-view-$id8-$TAG"; fi
  [ -z "$(calls_since "$n0" | grep -- "<script> agmux $TAG\$")" ] && ok "3b no reap exec (as intended)" || bad "3b unexpected reap"

  # 4. full: status bar + C-a prefix, recorded pid is a tmux client, C-a d exits 0
  attach_as_user full && wait_for 15 has ": work [" rtmux list-clients || { bad "4 full attach"; return; }
  wait_for 10 has "[work]" T capture-pane -p -t "$PANE" && ok "4 full: inner status bar visible: $(T capture-pane -p -t "$PANE" | grep -F '[work]' | tr -s ' ' | cut -c1-60)" || bad "4 status bar"
  ok "4 sandbox prefix: $(rtmux show -gv prefix)"
  c=$(x sh -c 'read -r m s p < "$HOME/.agmux/attach/$1"; echo "$m $p $(ps -o comm= -p "$p")"' agmux "$TAG")
  case $c in "full "*" tmux"*) ok "4 state + ps -o comm= of the recorded pid: $c" ;; *) bad "4 recorded pid: $c" ;; esac
  T set -p -t "$PANE" remain-on-exit on
  t0=$(ms); T send-keys -t "$PANE" C-a d
  wait_for 10 has 1 T display -p -t "$PANE" '#{pane_dead}' || true
  c=$(T display -p -t "$PANE" '#{pane_dead_status}')
  [ "$c" = 0 ] && ok "4 C-a d: exit 0 after $(($(ms) - t0)) ms" || bad "4 C-a d status '$c'"
  T kill-window -t "$WIN"
  #    full-mode hangup reap: kill-window kills the recorded client
  attach_as_user full && wait_for 15 has ": work [" rtmux list-clients || { bad "4 full attach (2)"; return; }
  pid=$(x sh -c 'read -r m s p < "$HOME/.agmux/attach/$1"; echo "$p"' agmux "$TAG")
  n0=$(wc -l <"$M/calls.log"); t0=$(ms); T kill-window -t "$WIN"
  if wait_for 5 lacks tmux x sh -c 'ps -o comm= -p "$1"' agmux "$pid"; then ok "4 full client $pid gone $(($(ms) - t0)) ms after kill-window"; else bad "4 full client survived"; fi
  [ -n "$(calls_since "$n0" | grep -- "<script> agmux $TAG\$")" ] && ok "4 full reap exec ran" || bad "4 no full reap exec"

  # 5. stopped sandbox: attach starts it first
  t0=$(ms); os sandbox stop "$SBX" >/dev/null </dev/null
  wait_for 60 phase_is Stopped || { bad "5 not Stopped"; return; }
  echo "info 5 Stopped after $(($(ms) - t0)) ms"
  if lacks "$SBX" os sandbox list --selector agmux=1; then echo "info 5 stopped sandbox dropped out of sandbox list: skipped"; return; fi
  sleep 12 # let the hub see it (host turns stale; the row stays live)
  echo "info 5 hub: $("$M/bin/agmux" hub status | grep "$SBX" | cut -c1-90)"
  n0=$(wc -l <"$M/calls.log"); t0=$(ms)
  attach_as_user view || { bad "5 attach on stopped sandbox"; return; }
  wait_for 90 has "Press any key" T capture-pane -p -t "$PANE" || wait_for 30 has turn T capture-pane -p -t "$PANE" || true
  calls_since "$n0" | awk -v t0="$t0" '{printf "info 5   +%d ms", $1 - t0; $1 = ""; print}'
  phase_is Ready && ok "5 sandbox Ready again" || bad "5 sandbox not started"
  echo "info 5 local pane: $(T capture-pane -p -t "$PANE" | grep -v '^$' | tail -2 | tr '\n' ' ' | cut -c1-200)"
  T kill-window -t "$WIN" 2>/dev/null || true
  #    the agent died with the container: start it again, attach the new session
  #    (the old row stays live until the sandbox hub's liveness sweep, up to ~60 s)
  echo "info 5 old row ${ID:0:8}: $("$M/bin/agmux" ls --remote | awk -v i="$id8" 'index($1, i) == 1 {print $7}')"
  start_stub
  wait_for 90 new_id "${ID:0:23}" >/dev/null || { bad "5 new session"; return; }
  ID=$(full_id "$(new_id "${ID:0:23}")")
  wait_for 30 has_coords "$ID" || true
  t0=$(ms); attach_as_user view || { bad "5 attach new session"; return; }
  if wait_for 15 has turn T capture-pane -p -t "$PANE"; then ok "5 new session ${ID:0:8}: output after $(($(ms) - t0)) ms"; else bad "5 new session output"; fi
  T send-keys -t "$PANE" M-d
}

hub_alive() { [ -f "$M/.agmux/hub.pid" ] && kill -0 "$(cat "$M/.agmux/hub.pid")" 2>/dev/null; }
sbx_exists() { "$OS" -g "$GW" sandbox get "$SBX" </dev/null >/dev/null 2>&1; }

# EXIT trap: deletes the sandbox only if this run created it; exit 1 on a leak.
p2_teardown() {
  local rc=$? leak=0
  set +e
  T kill-server 2>/dev/null
  [ -f "$WORK/ctl.pid" ] && kill "$(cat "$WORK/ctl.pid")" 2>/dev/null
  [ -f "$M/.agmux/hub.pid" ] && kill "$(cat "$M/.agmux/hub.pid")" 2>/dev/null
  if [ "${CREATED:-}" = 1 ]; then
    "$OS" -g "$GW" sandbox delete "$SBX" >/dev/null 2>&1 </dev/null
    if wait_for 30 eval '! sbx_exists'; then echo "teardown: $SBX deleted"; else echo "FAIL teardown: $SBX still exists"; leak=1; fi
  else
    echo "teardown: $SBX not created by this run, not deleted"
  fi
  if [ -n "$(T list-sessions 2>/dev/null)" ] || ! wait_for 5 eval '! hub_alive'; then
    echo "FAIL teardown: outer tmux or hub still running ($WORK kept)"; leak=1
  elif [ "${WORK_MADE:-}" = 1 ]; then
    rm -rf "$WORK"
  fi
  [ "$leak" = 1 ] && exit 1
  exit "$rc"
}

# Guardrails, before any openshell call: only the scratch gateway, only agmux-p2-*
# sandboxes, and never one that already exists (the trap would delete it).
p2_guard() {
  [ "$GW" = ai-sandbox ] || { echo "refusing: phase2 runs on gateway ai-sandbox only (GW=$GW)" >&2; return 1; }
  case $SBX in agmux-p2-*) ;; *) echo "refusing: phase2 sandbox must be agmux-p2-* (SBX=$SBX)" >&2; return 1 ;; esac
  case $SBX in *[!a-z0-9-]*) echo "refusing: SBX=$SBX is not [a-z0-9-]" >&2; return 1 ;; esac
}

phase2() {
  M=$WORK/mac
  if ! p2_guard; then [ "${WORK_MADE:-}" = 1 ] && rm -rf "$WORK"; exit 2; fi
  if sbx_exists; then
    echo "refusing: sandbox $SBX already exists on $GW; delete it by hand first" >&2
    [ "${WORK_MADE:-}" = 1 ] && rm -rf "$WORK"; exit 2
  fi
  trap p2_teardown EXIT
  echo "observed on: openshell $("$OS" --version | awk '{print $2}') (client), gateway $("$OS" -g "$GW" status 2>/dev/null | awk '/Version/{print $2}'), Mac tmux $(tmux -V | awk '{print $2}')"
  p2_setup
  echo "observed on: sandbox $(x tmux -V), $(x agmux --version | head -1)"
  phase2_checks
  echo "failures: $FAILS"
  [ "$FAILS" = 0 ]
}

"${1:?usage: phase1-smoke.sh setup|check|teardown|phase2}"
