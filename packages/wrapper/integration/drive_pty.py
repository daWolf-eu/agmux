import os, pty, sys, select, time, signal, struct, fcntl, termios, subprocess

# Drive the wrapper under a real PTY with a known window size, capture output.
WRAPPER = "packages/wrapper/integration/standalone_wrapper.ts"
ROWS, COLS = 40, 100

def run_under_pty(argv, rows=ROWS, cols=COLS, timeout=10, send=None):
    """Fork a PTY, set window size, exec argv, capture output."""
    pid, fd = pty.fork()
    if pid == 0:
        ws = struct.pack("HHHH", rows, cols, 0, 0)
        fcntl.ioctl(0, termios.TIOCSWINSZ, ws)
        os.execvp(argv[0], argv)
    else:
        if send is not None:
            # brief pause so the child can start up
            time.sleep(0.3)
            try:
                os.write(fd, send)
            except OSError:
                pass
        out = b""
        deadline = time.time() + timeout
        while time.time() < deadline:
            remaining = deadline - time.time()
            try:
                r, _, _ = select.select([fd], [], [], min(remaining, 0.5))
            except select.error:
                break
            if not r:
                if time.time() >= deadline:
                    break
                continue
            try:
                data = os.read(fd, 4096)
            except OSError:
                break
            # empty read signals EOF (child exited, master drained)
            if not data:
                break
            out += data
        _, status = os.waitpid(pid, 0)
        exitcode = os.WEXITSTATUS(status) if os.WIFEXITED(status) else None
        signum  = os.WTERMSIG(status)    if os.WIFSIGNALED(status) else None
        return out.decode(errors="replace"), exitcode, signum

PASS = 0
FAIL = 0

def check(label, cond, detail=""):
    global PASS, FAIL
    if cond:
        print(f"  PASS  {label}")
        PASS += 1
    else:
        print(f"  FAIL  {label}" + (f": {detail}" if detail else ""))
        FAIL += 1

def bun_wrapper(*args):
    return ["bun", WRAPPER, "--"] + list(args)

def main():
    print(f"=== drive_pty.py  wrapper={WRAPPER}  rows={ROWS} cols={COLS} ===\n")

    # ── 1. tty=true: child's stdin must be a real tty ──────────────────────────
    print("1. tty transparency")
    out, ec, sig = run_under_pty(bun_wrapper("sh", "-c", "tty; echo tty_exit=$?"))
    check("tty not 'not a tty'", "not a tty" not in out, repr(out))
    check("tty exit 0",          "tty_exit=0" in out,    repr(out))

    # ── 2. isatty: child sees fd 0/1/2 as ttys ────────────────────────────────
    print("\n2. isatty checks")
    script = (
        "python3 -c \""
        "import os; "
        "print('isatty0='+str(os.isatty(0))); "
        "print('isatty1='+str(os.isatty(1))); "
        "print('isatty2='+str(os.isatty(2)))"
        "\""
    )
    out, ec, sig = run_under_pty(bun_wrapper("sh", "-c", script))
    check("isatty(0)=True", "isatty0=True" in out, repr(out))
    check("isatty(1)=True", "isatty1=True" in out, repr(out))
    check("isatty(2)=True", "isatty2=True" in out, repr(out))

    # ── 3. initial window size ─────────────────────────────────────────────────
    print("\n3. initial window size (rows=40 cols=100)")
    size_script = (
        "python3 -c \""
        "import fcntl, termios, struct; "
        "ws = struct.unpack('HHHH', fcntl.ioctl(0, termios.TIOCGWINSZ, b'\\x00'*8)); "
        "print('rows='+str(ws[0])); print('cols='+str(ws[1]))"
        "\""
    )
    out, ec, sig = run_under_pty(bun_wrapper("sh", "-c", size_script), rows=ROWS, cols=COLS)
    check(f"rows={ROWS}", f"rows={ROWS}" in out, repr(out))
    check(f"cols={COLS}", f"cols={COLS}" in out, repr(out))

    # ── 4. exit-code propagation ───────────────────────────────────────────────
    print("\n4. exit-code propagation")
    for code in [0, 1, 42]:
        out, ec, sig = run_under_pty(bun_wrapper("sh", "-c", f"exit {code}"))
        check(f"exit {code}", ec == code, f"got ec={ec} sig={sig}")

    # ── 5. SIGTERM → exit 143 ─────────────────────────────────────────────────
    print("\n5. SIGTERM propagation (sleep child → exit 143)")
    # We send SIGTERM to the outer pty child (the wrapper); the wrapper should
    # forward it to its child (sleep) and then exit 143.
    pid, fd = pty.fork()
    if pid == 0:
        ws = struct.pack("HHHH", ROWS, COLS, 0, 0)
        fcntl.ioctl(0, termios.TIOCSWINSZ, ws)
        os.execvp("bun", ["bun", WRAPPER, "--", "sleep", "30"])
    else:
        time.sleep(0.6)          # let wrapper + sleep start
        os.kill(pid, signal.SIGTERM)
        out = b""
        deadline = time.time() + 3
        while time.time() < deadline:
            try:
                r, _, _ = select.select([fd], [], [], 0.3)
                if r:
                    chunk = os.read(fd, 4096)
                    if chunk: out += chunk
            except OSError:
                break
        _, status = os.waitpid(pid, 0)
        ec   = os.WEXITSTATUS(status) if os.WIFEXITED(status)   else None
        sig2 = os.WTERMSIG(status)    if os.WIFSIGNALED(status) else None
        # wrapper re-raises SIGTERM → parent sees signal 15, or it self-exits 143
        terminated_correctly = (ec == 143) or (sig2 == signal.SIGTERM)
        check("SIGTERM → 143 or signal 15", terminated_correctly, f"ec={ec} sig={sig2}")

    print(f"\n{'='*50}")
    print(f"Results: {PASS} passed, {FAIL} failed")
    if FAIL:
        sys.exit(1)

main()
