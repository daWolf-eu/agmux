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

// Inline-source TinyCC shim for non-variadic ioctl(TIOCSWINSZ).
// Hard-coded value lets the same C source build on both platforms.
const C_SRC = `#include <sys/ioctl.h>
#include <termios.h>
int agmux_set_winsize(int fd, unsigned short rows, unsigned short cols, unsigned int tiocswinsz_val) {
  struct winsize ws; ws.ws_row = rows; ws.ws_col = cols; ws.ws_xpixel = 0; ws.ws_ypixel = 0;
  return ioctl(fd, tiocswinsz_val, &ws);
}`;

const cFile = path.join(os.tmpdir(), `agmux-setwinsz-${process.pid}.c`);
fs.writeFileSync(cFile, C_SRC);
const winszLib = cc({
  source: cFile,
  symbols: {
    agmux_set_winsize: { args: ["int", "u16", "u16", "u32"], returns: "int" },
  },
});
try { fs.unlinkSync(cFile); } catch {}

export function setWinsize(fd: number, rows: number, cols: number): number {
  return winszLib.symbols.agmux_set_winsize(fd, rows, cols, TIOCSWINSZ);
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
