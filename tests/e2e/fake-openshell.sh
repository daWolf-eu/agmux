#!/bin/sh
# Stand-in for the openshell CLI in e2e tests: only the two verbs the hub's sync loop runs.
#   -g <gw> sandbox list -o json --selector <sel>      → $FAKE_OS_DIR/list.json
#   -g <gw> sandbox exec -n <name> --no-tty -- <cmd…>  → <cmd…> with HOME=$FAKE_OS_DIR/<name>
#                                                         and AGMUX_HOST=<gw>/<name>
# Like openshell 0.0.116, exec starts <cmd…> only once the local stdin reaches EOF,
# so a caller that holds stdin open hangs here too.
# A name listed (one per line) in $FAKE_OS_DIR/nohost gets no AGMUX_HOST, like an old sandbox.
die() { echo "fake-openshell: $*" >&2; exit 2; }

[ -n "$FAKE_OS_DIR" ] || die "FAKE_OS_DIR is not set"
[ "$1" = "-g" ] && [ -n "$2" ] || die "expected -g <gateway>"
gw=$2
shift 2
[ "$1" = "sandbox" ] || die "expected 'sandbox', got '$1'"
shift

case "$1" in
  list)
    [ "$2" = "-o" ] && [ "$3" = "json" ] && [ "$4" = "--selector" ] && [ -n "$5" ] \
      || die "expected 'list -o json --selector <sel>'"
    exec cat "$FAKE_OS_DIR/list.json"
    ;;
  exec)
    shift
    name=""
    while [ $# -gt 0 ]; do
      case "$1" in
        -n) name=$2; shift 2 ;;
        --tty|--no-tty) shift ;;
        --) shift; break ;;
        *) die "unknown exec argument '$1'" ;;
      esac
    done
    [ -n "$name" ] || die "exec needs -n <name>"
    [ $# -gt 0 ] || die "exec needs -- <cmd…>"
    [ -d "$FAKE_OS_DIR/$name" ] || die "no sandbox '$name'"
    export HOME="$FAKE_OS_DIR/$name"
    if [ -f "$FAKE_OS_DIR/nohost" ] && grep -qxF "$name" "$FAKE_OS_DIR/nohost"; then
      unset AGMUX_HOST
    else
      export AGMUX_HOST="$gw/$name"
    fi
    cat >/dev/null
    exec "$@" </dev/null
    ;;
  *) die "unsupported verb '$1'" ;;
esac
