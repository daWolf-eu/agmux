# agmux PTY-on-Bun feasibility spike

**Date:** 2026-05-27  **Platform:** macOS 14.7.4 (darwin, arm64)  **Bun:** 1.3.14 (installed via Homebrew; `curl|bash` installer was blocked by the sandbox, `brew install oven-sh/bun/bun` worked)

**Verdict: GO, with caveats.** A transparent interactive-CLI wrapper in TypeScript on Bun is feasible today. All four required capabilities are confirmed working, including as a `bun build --compile` single binary. The viable approach is **`openpty()` via `bun:ffi` + `Bun.spawn` with the PTY slave fd as stdio** — NOT `node-pty`.

---

## 1. Does PTY work under Bun?

| Approach | Result |
|---|---|
| **`node-pty@1.1.0`** | **NO-GO.** Loads fine (ships prebuilt `darwin-arm64/pty.node`, no compile step). But `pty.spawn()` throws `Error: posix_spawnp failed.` (in `UnixTerminal`, `unixTerminal.js:92`). The native fork path is incompatible with Bun's runtime. Dead end. |
| **`Bun.spawn({ pty: true })`** | **NO-GO (silent).** The `pty: true` option is *accepted* (no error) but is a no-op: the child reports `not a tty` / `TTY_NO`. No real PTY allocation as of 1.3.14. |
| **`openpty()` via `bun:ffi` (libSystem) + `Bun.spawn`** | **WORKS.** `dlopen("libSystem.dylib", { openpty })` returns a valid master/slave fd pair. Passing the slave fd to `Bun.spawn({ stdin, stdout, stderr })` gives the child a real controlling tty (`/dev/ttysNNN`, `isatty`=true). This is the recommended path. |

No `bun`-specific PTY package exists that works; the FFI route is the answer.

## 2. TTY transparency — CONFIRMED

- **isatty:** child sees a real tty on fd 0, 1, and 2 (`test -t 0/2` → true; `tty` → `/dev/ttysNNN`).
- **Terminal size (initial):** propagates. Set via `openpty`'s 5th `winp` argument (`struct winsize {u16 row, col, xpixel, ypixel}`). Parent PTY 40x100 → child `stty size` = `40 100`.
- **Dynamic resize / SIGWINCH:** propagates. Bun emits `process.stdout.on("resize")` and updates `process.stdout.rows/columns` correctly under a PTY. Wrapper calls `ioctl(TIOCSWINSZ)` on the master; child receives SIGWINCH and `stty size` updates (24x80 → 60x200 confirmed by polling).
- **Raw-mode key input:** passes through verbatim. Fed `1b 5b 41` (Up arrow) + `78` (`x`) + `03` (Ctrl-C) → child read exactly `1b 5b 41 78 03`. Parent set to `setRawMode(true)`; child manages its own line discipline. Arrows, Ctrl-C-as-byte, and arbitrary escape sequences transit unmodified.

## 3. Signal & exit-code transparency — CONFIRMED

- Normal exit code preserved: `exit 42` → wrapper exits **42**; `exit 0` → 0.
- Signal death mapped to `128+signal`: child killed by SIGTERM → wrapper exits **143**; SIGINT → **130**. Bun reports `child.exitCode=null, child.signalCode="SIGTERM"`; wrapper re-raises the same signal to itself.
- **Gotcha:** the wrapper's own SIGINT/SIGTERM forwarding handlers will *swallow* the re-raised signal — must `process.removeAllListeners(sig)` before re-raising, else it falls through and exits 0.
- Ctrl-C/SIGINT forwarding (not interactively tested): with the parent in raw mode the `0x03` byte is delivered to the child's tty, whose line discipline turns it into SIGINT for the child's foreground group — the correct, native behavior. The explicit `process.on("SIGINT")→child.kill` handler is a belt-and-suspenders fallback for when the wrapper itself is signaled out-of-band.

## 4. Env injection — CONFIRMED

`Bun.spawn({ env: { ...process.env, AGMUX_SESSION_ID } })`. Child `echo $AGMUX_SESSION_ID` returns the injected value; caller-supplied `AGMUX_SESSION_ID` env overrides the default.

---

## Bun-specific gotchas (for the real implementation)

1. **node-pty is out.** `posix_spawnp failed` on spawn. Do not rely on it.
2. **`Bun.spawn({pty:true})` is a silent no-op** — do not mistake "no error" for "works".
3. **One fd cannot back all three stdio slots.** `Bun.spawn({stdin:s, stdout:s, stderr:s})` throws `ERR_INVALID_ARG_TYPE: stdin cannot be used for stdout or stderr`. Use `dup(slave)` (via FFI) to make a distinct fd per stream. (It appeared to work in some early runs — non-deterministic; always dup.)
4. **`bun:ffi` cannot call variadic `ioctl(2)` directly.** Declaring `ioctl` and calling `TIOCSWINSZ`/`TIOCGWINSZ` either silently no-ops or **segfaults Bun** (TIOCGWINSZ reliably crashes). Workaround: a tiny **non-variadic C shim** compiled at runtime by Bun's bundled TinyCC via `cc()`. Avoid `ioctl` for initial size by using `openpty`'s `winp` arg instead.
5. **`cc()` source is NOT bundled by `bun build --compile`.** It tries to read `/$bunfs/root/<file>.c` at runtime and fails (`file not found`). Fix: inline the C as a string and write it to `os.tmpdir()` at startup, then point `cc()` at that path. With this, the single binary is self-contained.
6. **Async event loop:** node-pty-style `onData`/`onExit` and `setTimeout` produced no output in `bun -e` one-liners (loop exited early); use a proper script and `await child.exited`.

## `bun build --compile` — WORKS

`bun build --compile wrapper.ts --outfile agmux-wrap` produces a ~63 MB standalone binary. After moving the temp-C-file fix in (gotcha #5), the binary passes the **entire** matrix with no external files: TTY, env injection, exit 42, SIGTERM→143, initial size 40x100, dynamic resize 24x80→60x200, and raw key passthrough.

## Files

- `wrapper.ts` — the prototype. Run: `bun wrapper.ts -- <command> [args...]` (or the compiled `./agmux-wrap -- <command>`).
- `setwinsz.c` — reference copy of the C shim (the wrapper now inlines this string itself; the standalone file is not required at runtime).
- `drive.py` / `drive_resize.py` / `drive_input2.py` — Python PTY harnesses used to drive the wrapper non-interactively (give it a real controlling tty, resize it, feed raw bytes).

## Recommendation

Build agmux's wrapper core on **`bun:ffi` openpty + `Bun.spawn`**. The technique is sound and compiles to a single distributable binary. Budget for: the `dup` requirement, the TinyCC `cc()` shim for resize (with the temp-file trick for `--compile`), and Linux portability work (`libSystem.dylib` → `libutil.so.1`/`libc`, and the `TIOCSWINSZ` constant differs from macOS — handle per-platform). The 63 MB binary size is the Bun baseline; acceptable but worth noting.
