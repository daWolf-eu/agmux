// agmux PTY wrapper spike — Bun + FFI(openpty) + Bun.spawn
// Usage: bun wrapper.ts -- <command> [args...]
//
// Transparent process wrapper on Bun:
//  - allocates a real PTY via libSystem openpty() through bun:ffi
//    (initial window size set via openpty's winp arg — no ioctl needed at startup)
//  - spawns the child with the PTY slave fd as stdin/stdout/stderr (child sees a real tty)
//  - pipes parent stdin -> pty master, pty master -> parent stdout
//  - raw mode on parent tty so keys (arrows, ctrl-c, etc.) pass through verbatim
//  - dynamic resize: ioctl(TIOCSWINSZ) via an inline-compiled C helper (bun:ffi `cc`),
//    because Bun's plain FFI mishandles the variadic ioctl() signature
//  - injects AGMUX_SESSION_ID into the child env
//  - exits with the child's exit code (re-raises terminating signals)

import { dlopen, FFIType, ptr, cc } from "bun:ffi";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const lib = dlopen("libSystem.dylib", {
  // int openpty(int *amaster, int *aslave, char *name, struct termios *termp, struct winsize *winp);
  openpty: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.int },
  // int dup(int fd) — Bun.spawn rejects reusing one fd for stdin+stdout+stderr, so we dup.
  dup: { args: [FFIType.int], returns: FFIType.int },
});

// Non-variadic ioctl(TIOCSWINSZ) wrapper compiled at runtime by Bun's bundled TinyCC.
// (Bun's bare FFI mishandles the variadic ioctl(2) signature — segfaults / silent no-op.)
// The C source is inlined and written to a temp file so this also works inside a
// `bun build --compile` single binary (cc() reads from disk, not the bundled VFS).
const C_SRC = `#include <sys/ioctl.h>
#include <termios.h>
int agmux_set_winsize(int fd, unsigned short rows, unsigned short cols) {
  struct winsize ws; ws.ws_row = rows; ws.ws_col = cols; ws.ws_xpixel = 0; ws.ws_ypixel = 0;
  return ioctl(fd, TIOCSWINSZ, &ws);
}`;
const cFile = path.join(os.tmpdir(), `agmux-setwinsz-${process.pid}.c`);
fs.writeFileSync(cFile, C_SRC);
const winszLib = cc({
  source: cFile,
  symbols: { agmux_set_winsize: { args: ["int", "u16", "u16"], returns: "int" } },
});
try { fs.unlinkSync(cFile); } catch {}
const setWinsize = (fd: number, rows: number, cols: number) =>
  winszLib.symbols.agmux_set_winsize(fd, rows, cols);

// ---- parse args after `--` ----
const sep = process.argv.indexOf("--");
const cmd = sep >= 0 ? process.argv.slice(sep + 1) : process.argv.slice(2);
if (cmd.length === 0) {
  console.error("usage: bun wrapper.ts -- <command> [args...]");
  process.exit(2);
}

const initRows = process.stdout.rows || 24;
const initCols = process.stdout.columns || 80;

// ---- allocate pty with initial size baked in via winp ----
const masterArr = new Int32Array(1);
const slaveArr = new Int32Array(1);
const winp = new Uint16Array([initRows, initCols, 0, 0]); // {ws_row, ws_col, ws_xpixel, ws_ypixel}
if (lib.symbols.openpty(ptr(masterArr), ptr(slaveArr), null, null, ptr(winp)) !== 0) {
  console.error("openpty failed");
  process.exit(1);
}
const master = masterArr[0];
const slave = slaveArr[0];

// ---- spawn child attached to the pty slave (separate fd per stream) ----
const slaveOut = lib.symbols.dup(slave);
const slaveErr = lib.symbols.dup(slave);
const child = Bun.spawn(cmd, {
  stdin: slave,
  stdout: slaveOut,
  stderr: slaveErr,
  env: { ...process.env, AGMUX_SESSION_ID: process.env.AGMUX_SESSION_ID ?? "agmux-spike-001" },
});

// parent no longer needs the slave fds
for (const fd of [slave, slaveOut, slaveErr]) { try { fs.closeSync(fd); } catch {} }

// ---- raw mode on parent stdin so keystrokes pass through verbatim ----
const stdinIsTty = process.stdin.isTTY;
if (stdinIsTty) process.stdin.setRawMode(true);
const restore = () => { if (stdinIsTty) { try { process.stdin.setRawMode(false); } catch {} } };

// ---- pump master -> parent stdout ----
const masterReadStream = fs.createReadStream("", { fd: master, autoClose: false });
masterReadStream.on("data", (chunk) => process.stdout.write(chunk));
masterReadStream.on("error", () => {}); // EIO on child exit is expected

// ---- pump parent stdin -> master ----
process.stdin.on("data", (chunk: Buffer) => { try { fs.writeSync(master, chunk); } catch {} });
if (stdinIsTty) process.stdin.resume();

// ---- forward window resizes ----
process.stdout.on("resize", () => {
  setWinsize(master, process.stdout.rows || 24, process.stdout.columns || 80);
  // kernel tty layer delivers SIGWINCH to the child automatically
});

// ---- forward terminating signals to the child ----
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"] as const) {
  process.on(sig, () => { try { child.kill(sig); } catch {} });
}

// ---- exit with child's status ----
await child.exited;
restore();
try { fs.closeSync(master); } catch {}

if (child.signalCode) {
  // Re-raise so the wrapper appears to die from the same signal.
  // Remove our own forwarding handlers first, else they'd swallow the re-raised signal.
  process.removeAllListeners(child.signalCode);
  process.kill(process.pid, child.signalCode);
} else {
  process.exit(child.exitCode ?? 0);
}
