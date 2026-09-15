import { ptr, cc } from "bun:ffi";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const isDarwin = process.platform === "darwin";
const isLinux = process.platform === "linux";

if (!isDarwin && !isLinux) {
  throw new Error(`agmux-wrap: unsupported platform ${process.platform}`);
}

const platformLib = isDarwin
  ? (await import("./ffi-darwin.ts")).darwinLib
  : (await import("./ffi-linux.ts")).linuxLib;

const TIOCSWINSZ = isDarwin
  ? (await import("./ffi-darwin.ts")).TIOCSWINSZ
  : (await import("./ffi-linux.ts")).TIOCSWINSZ;

// Inline-source TinyCC shim for ioctl(TIOCSWINSZ): Bun's FFI cannot express a
// variadic call, so the one non-variadic wrapper gets compiled at runtime.
//
// Deliberately includes NO system headers. `struct winsize` (four unsigned
// shorts) and ioctl's signature are stable ABI on both darwin and linux, so
// declaring them here costs nothing and buys a lot: TinyCC needs no SDK headers,
// which used to make this module unusable whenever macOS could not resolve one.
// (`xcrun` failing — an unaccepted Xcode licence after an update, or an
// xcode-select path pointing at a moved Xcode.app — is enough to hide
// sys/ioctl.h entirely.)
const C_SRC = `struct agmux_winsize { unsigned short ws_row, ws_col, ws_xpixel, ws_ypixel; };
extern int ioctl(int, unsigned long, ...);
int agmux_set_winsize(int fd, unsigned short rows, unsigned short cols, unsigned long tiocswinsz_val) {
  struct agmux_winsize ws; ws.ws_row = rows; ws.ws_col = cols; ws.ws_xpixel = 0; ws.ws_ypixel = 0;
  return ioctl(fd, tiocswinsz_val, &ws);
}`;

type WinszFn = (fd: number, rows: number, cols: number, req: number) => number;

// Compiled on first use, never at import. The wrapper barrel re-exports this
// module alongside the TOML config loaders, so a top-level cc() made every agmux
// command — `hub restart`, `ls`, `dash` — compile C just to read a config file,
// and fail outright when the toolchain could not. Only a live PTY resize needs
// this, so only a live PTY resize pays for it.
let winsz: WinszFn | null = null;
let winszFailed = false;

function loadWinsz(): WinszFn | null {
  if (winsz) return winsz;
  if (winszFailed) return null;
  const cFile = path.join(os.tmpdir(), `agmux-setwinsz-${process.pid}.c`);
  try {
    fs.writeFileSync(cFile, C_SRC);
    const lib = cc({
      source: cFile,
      symbols: {
        agmux_set_winsize: { args: ["int", "u16", "u16", "u64"], returns: "int" },
      },
    });
    winsz = lib.symbols.agmux_set_winsize as WinszFn;
    return winsz;
  } catch (e) {
    // Losing resize propagation degrades an agent session; throwing out of a
    // SIGWINCH handler would kill it. Say so once and carry on.
    winszFailed = true;
    console.error(`agmux-wrap: terminal resize will not propagate (cannot build ioctl shim: ${e instanceof Error ? e.message : String(e)})`);
    return null;
  } finally {
    try { fs.unlinkSync(cFile); } catch {}
  }
}

export function setWinsize(fd: number, rows: number, cols: number): number {
  const fn = loadWinsz();
  if (!fn) return -1;
  return fn(fd, rows, cols, TIOCSWINSZ);
}

export interface PtyHandles { master: number; slave: number; slaveOut: number; slaveErr: number; }

export function openPty(initRows: number, initCols: number): PtyHandles {
  const masterArr = new Int32Array(1);
  const slaveArr = new Int32Array(1);
  const winp = new Uint16Array([initRows, initCols, 0, 0]);
  const rc = platformLib.symbols.openpty(ptr(masterArr), ptr(slaveArr), null, null, ptr(winp));
  if (rc !== 0) throw new Error(`openpty failed (rc=${rc})`);
  const slave = slaveArr[0]!;
  return {
    master: masterArr[0]!,
    slave,
    slaveOut: platformLib.symbols.dup(slave)!,
    slaveErr: platformLib.symbols.dup(slave)!,
  };
}
