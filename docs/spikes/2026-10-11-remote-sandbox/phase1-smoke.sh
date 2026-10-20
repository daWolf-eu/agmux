#!/usr/bin/env bash
# Phase 1 smoke test against a real OpenShell gateway, without any image change:
# binaries are uploaded, the Mac side runs an isolated hub under a temp HOME, so
# the developer's own hub, config and status line are untouched.
#
#   IMAGE=openshell-workbench:e797e53b7f50 docs/spikes/2026-10-11-remote-sandbox/phase1-smoke.sh setup
#   … then: check | teardown
#
# OS: the openshell client to use (default: openshell on PATH). It must be
# compatible with the gateway; no particular version is required.
set -euo pipefail
REPO=$(cd "$(dirname "$0")/../../.." && pwd)
GW=${GW:-ai-sandbox}
SBX=${SBX:-agmux-smoke}
OS=${OS:-openshell}
IMAGE=${IMAGE:?set IMAGE to the workbench image tag on the gateway host}
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

"${1:?usage: phase1-smoke.sh setup|check|teardown}"
