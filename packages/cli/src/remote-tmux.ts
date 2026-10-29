// The fixed sh scripts a remote (sandbox) attach runs on the sandbox's tmux,
// and their argv builders. The Mac runs them as
// `openshell … sandbox exec -- sh -c <SCRIPT> agmux <args…>`: the sandbox needs
// only sh + tmux. Values from a replicated row are untrusted; they enter ONLY
// as positional parameters (validated by the caller, isRemoteTmux / isAttachTag
// / isTmuxKeyName), are copied to named variables on the first line, and are
// always expanded double-quoted. No eval, no value is ever part of the text.
//
// Exit codes: 0 the client ended normally; 3 the target is gone (or its tmux server restarted) or the view
// could not be built (message on stderr); anything else comes from tmux.
//
// Reap state ($HOME/.agmux/attach/<tag>, one line): `view <socket|-> <view>`
// or `full <socket|-> <client pid>`. Every script first reaps its tag, so a
// client orphaned by a closed local window or a Mac crash dies on the next
// attach from the same local pane; REAP_SCRIPT does only that.
import { isTmuxServerId, TMUX_SERVER_ID_FMT, type RemoteTmux } from "@agmux/protocol";

// `${sock:--}` (sh: "-" when empty) kept out of the template literals.
const SOCK_OR_DASH = '"${sock:--}"';

// Shared by all three scripts. `t` runs tmux on the row's socket (if any).
// Full-mode reap kills the recorded pid only while it is still a tmux attach
// client (the pid may be reused, the state file outlives a normal exit):
// `ps -o comm=` is a tmux (the basename on Linux, the exec path on macOS) AND
// `ps -o args=` holds `attach-session` (the client's args are the script's own
// exec line; the server's `tmux: server` title on Linux matches comm only).
export const REAP_FN = String.raw`st=$HOME/.agmux/attach
t() { if [ -n "$sock" ]; then tmux -S "$sock" "$@"; else tmux "$@"; fi; }
reap() {
  f=$st/$1; [ -f "$f" ] || return 0
  read -r m s x < "$f"; rm -f "$f"
  [ "$s" = - ] && s=
  case $m in
    view) if [ -n "$s" ]; then tmux -S "$s" kill-session -t "=$x"; else tmux kill-session -t "=$x"; fi 2>/dev/null ;;
    full) case $(ps -o comm= -p "$x" 2>/dev/null) in
        tmux*|*/tmux) case $(ps -o args= -p "$x" 2>/dev/null) in *attach-session*) kill "$x" ;; esac ;;
      esac ;;
  esac
  return 0
}`;

// $srv is the server id recorded with the row ("-" unknown: skipped). A restarted
// sandbox tmux server reuses the socket path and @0, so the window check alone
// would pass for a different agent. An id without "-" is pid only (rows from a
// tmux that did not report a start time). The formats are static text.
const SERVER_CHECK = String.raw`if [ "$srv" != - ]; then
  case $srv in *-*) cur=$(t display-message -p '${TMUX_SERVER_ID_FMT}' 2>/dev/null) ;; *) cur=$(t display-message -p '#{pid}' 2>/dev/null) ;; esac
  [ "$cur" = "$srv" ] \
    || { echo "agmux: the sandbox tmux server restarted; the session's window is gone" >&2; exit 3; }
fi`;

// Compares the output, not the status: display-message's target may fail, so
// an unknown window prints "" and exits 0 (observed on tmux 3.6a).
const WINDOW_CHECK = String.raw`[ "$(t display-message -p -t "$win" '#{window_id}' 2>/dev/null)" = "$win" ] \
  || { echo "agmux: the session's tmux window $win is gone" >&2; exit 3; }`;

// $1 socket, $2 window, $3 pane, $4 view, $5 key, $6 tag (spec §8.1 order), $7 server id.
// key-table agmux-view replaces root for mouse events too, so the view rebinds
// tmux's default click (select pane), drag (copy-mode) and wheel (copy-mode/scroll).
// The view is a plain session holding the agent's window (linked, never
// grouped: tmux 3.6a segfaults when a grouped session loses its last window).
export const VIEW_SCRIPT = String.raw`sock=$1 win=$2 pane=$3 view=$4 key=$5 tag=$6 srv=$7
${REAP_FN}
mkdir -p "$st" && reap "$tag"
${SERVER_CHECK}
${WINDOW_CHECK}
# Recorded before the build: a crash mid-build leaves a reapable view.
printf 'view %s %s\n' ${SOCK_OR_DASH} "$view" > "$st/$tag"
{ t new-session -d -s "$view" \
  && t set -t "$view" status off \; set -t "$view" prefix None \; set -t "$view" prefix2 None \
       \; set -t "$view" key-table agmux-view \; set -t "$view" mouse on \
  && t bind -T agmux-view "$key" detach-client \
  && t bind -T agmux-view MouseDown1Pane 'select-pane -t = ; send-keys -M' \
  && t bind -T agmux-view MouseDrag1Pane 'if-shell -F "#{||:#{pane_in_mode},#{mouse_any_flag}}" "send-keys -M" "copy-mode -M"' \
  && t bind -T agmux-view WheelUpPane 'if-shell -F "#{||:#{alternate_on},#{pane_in_mode},#{mouse_any_flag}}" "send-keys -M" "copy-mode -e"' \
  && t link-window -s "$win" -t "$view:" \
  && t kill-window -t "$view:^"; } \
  || { t kill-session -t "=$view" 2>/dev/null; echo "agmux: could not build the view" >&2; exit 3; }
[ -n "$pane" ] && t select-pane -t "$pane"
# destroy-unattached only here: set earlier it fires on kill-window (3.7c). -u: exec --tty sets no UTF-8 locale.
if [ -n "$sock" ]; then exec tmux -u -S "$sock" attach-session -t "=$view" \; set -t "$view" destroy-unattached on
else exec tmux -u attach-session -t "=$view" \; set -t "$view" destroy-unattached on; fi`;

// $1 socket, $2 session, $3 window, $4 pane, $5 tag, $6 server id. Records $$, then execs
// the client in place, so the recorded pid is the client's.
export const FULL_SCRIPT = String.raw`sock=$1 sess=$2 win=$3 pane=$4 tag=$5 srv=$6
${REAP_FN}
mkdir -p "$st" && reap "$tag"
${SERVER_CHECK}
${WINDOW_CHECK}
printf 'full %s %s\n' ${SOCK_OR_DASH} "$$" > "$st/$tag"
set -- attach-session -t "=$sess" \; select-window -t "$win"
[ -n "$pane" ] && set -- "$@" \; select-pane -t "$pane"
if [ -n "$sock" ]; then exec tmux -u -S "$sock" "$@"; else exec tmux -u "$@"; fi`;

// $1 tag.
export const REAP_SCRIPT = `sock=
${REAP_FN}
reap "$1"`;

export function viewSessionName(sessionId: string, tag: string): string {
  return `agmux-view-${sessionId.slice(0, 8)}-${tag}`;
}

// Unknown or malformed ids become "-" (check skipped).
const serverArg = (c: RemoteTmux): string => (c.server && isTmuxServerId(c.server) ? c.server : "-");

export function viewScriptArgv(c: RemoteTmux, view: string, key: string, tag: string): string[] {
  return ["sh", "-c", VIEW_SCRIPT, "agmux", c.socket ?? "", c.window, c.pane ?? "", view, key, tag, serverArg(c)];
}

export function fullScriptArgv(c: RemoteTmux, tag: string): string[] {
  return ["sh", "-c", FULL_SCRIPT, "agmux", c.socket ?? "", c.session, c.window, c.pane ?? "", tag, serverArg(c)];
}

export function reapScriptArgv(tag: string): string[] {
  return ["sh", "-c", REAP_SCRIPT, "agmux", tag];
}
