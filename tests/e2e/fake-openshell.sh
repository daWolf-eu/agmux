#!/bin/sh
# Stand-in for the openshell CLI in e2e tests: the verbs the hub's sync loop and a remote attach run.
#   -g <gw> sandbox list -o json --selector <sel>      → $FAKE_OS_DIR/list-<gw>.json if present,
#                                                         else $FAKE_OS_DIR/list.json
#   -g <gw> sandbox exec -n <name> --no-tty -- <cmd…>  → <cmd…> with HOME=$FAKE_OS_DIR/<name>,
#                                                         TMUX_TMPDIR=<resolved $HOME> (the sandbox's
#                                                         own default tmux server), AGMUX_HOST=<gw>/<name>,
#                                                         $TMUX/$TMUX_PANE unset, stdin closed
#   -g <gw> sandbox exec -n <name> --tty -- <cmd…>     → the same, with the terminal inherited
#   -g <gw> sandbox get <name> -o json                 → $FAKE_OS_DIR/<name>/sandbox.json,
#                                                         default {"phase":"Ready"}
#   -g <gw> sandbox start <name>                       → exits 0
# Like openshell (observed on 0.0.116), `exec --no-tty` starts <cmd…> only once the local stdin
# reaches EOF, so a caller that holds stdin open hangs here too. `--tty` does not wait: the
# command shares the caller's terminal.
# A name listed (one per line) in $FAKE_OS_DIR/nohost gets no AGMUX_HOST, like an old sandbox.
# Every call appends its argv to $FAKE_OS_DIR/calls.log, tab-joined, one line per call
# (a newline inside an argument, e.g. a script, is logged as a space).
die() { echo "fake-openshell: $*" >&2; exit 2; }

[ -n "$FAKE_OS_DIR" ] || die "FAKE_OS_DIR is not set"
tab=$(printf '\t')
line=$(sep=; for a in "$@"; do printf '%s%s' "$sep" "$a"; sep=$tab; done | tr '\n' ' ')
printf '%s\n' "$line" >> "$FAKE_OS_DIR/calls.log"

[ "$1" = "-g" ] && [ -n "$2" ] || die "expected -g <gateway>"
gw=$2
shift 2
[ "$1" = "sandbox" ] || die "expected 'sandbox', got '$1'"
shift

case "$1" in
  list)
    [ "$2" = "-o" ] && [ "$3" = "json" ] && [ "$4" = "--selector" ] && [ -n "$5" ] \
      || die "expected 'list -o json --selector <sel>'"
    [ -f "$FAKE_OS_DIR/list-$gw.json" ] && exec cat "$FAKE_OS_DIR/list-$gw.json"
    exec cat "$FAKE_OS_DIR/list.json"
    ;;
  get)
    [ -n "$2" ] && [ "$3" = "-o" ] && [ "$4" = "json" ] || die "expected 'get <name> -o json'"
    [ -d "$FAKE_OS_DIR/$2" ] || die "no sandbox '$2'"
    if [ -f "$FAKE_OS_DIR/$2/sandbox.json" ]; then exec cat "$FAKE_OS_DIR/$2/sandbox.json"; fi
    echo '{"phase":"Ready"}'
    ;;
  start)
    [ -n "$2" ] || die "expected 'start <name>'"
    [ -d "$FAKE_OS_DIR/$2" ] || die "no sandbox '$2'"
    exit 0
    ;;
  exec)
    shift
    name=""
    tty=""
    while [ $# -gt 0 ]; do
      case "$1" in
        -n) name=$2; shift 2 ;;
        --tty) tty=1; shift ;;
        --no-tty) tty=""; shift ;;
        --) shift; break ;;
        *) die "unknown exec argument '$1'" ;;
      esac
    done
    [ -n "$name" ] || die "exec needs -n <name>"
    [ $# -gt 0 ] || die "exec needs -- <cmd…>"
    [ -d "$FAKE_OS_DIR/$name" ] || die "no sandbox '$name'"
    export HOME="$FAKE_OS_DIR/$name"
    # The sandbox has its own tmux and never sees the Mac's. Resolved: a socket path is capped
    # at 104 bytes, and $FAKE_OS_DIR/<name> is a symlink into a shorter temp root.
    TMUX_TMPDIR=$(cd "$HOME" && pwd -P)
    export TMUX_TMPDIR
    unset TMUX TMUX_PANE
    if [ -f "$FAKE_OS_DIR/nohost" ] && grep -qxF "$name" "$FAKE_OS_DIR/nohost"; then
      unset AGMUX_HOST
    else
      export AGMUX_HOST="$gw/$name"
    fi
    [ -n "$tty" ] && exec "$@"
    cat >/dev/null
    exec "$@" </dev/null
    ;;
  *) die "unsupported verb '$1'" ;;
esac
