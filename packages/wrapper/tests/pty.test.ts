import { test, expect } from "bun:test";
import { cc, dlopen, ptr, FFIType } from "bun:ffi";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { openPty, setWinsize } from "../src/pty.ts";

// The ioctl shim is compiled at runtime by TinyCC. It deliberately includes no
// system headers, declaring `struct winsize` and ioctl itself, because a macOS
// box can easily have no resolvable SDK headers (an unaccepted Xcode licence, or
// xcode-select pointing at a moved Xcode.app) — which used to take down every
// agmux command, not just the PTY path. These tests pin both halves of that: the
// shim really builds without headers, and the struct it declares is ABI-correct.

// Read the winsize back through the same header-free technique, so a wrong
// struct layout cannot pass by being wrong identically on both sides: this
// declares the fields individually rather than as a struct.
const TIOCGWINSZ = process.platform === "darwin" ? 0x40087468 : 0x5413;

function makeGetter() {
  const src = `extern int ioctl(int, unsigned long, ...);
int agmux_test_get(int fd, unsigned short *out, unsigned long req) {
  unsigned short buf[4]; int rc = ioctl(fd, req, buf);
  out[0] = buf[0]; out[1] = buf[1]; return rc;
}`;
  const f = path.join(os.tmpdir(), `agmux-test-getwinsz-${process.pid}.c`);
  fs.writeFileSync(f, src);
  try {
    return cc({ source: f, symbols: { agmux_test_get: { args: ["int", "ptr", "u64"], returns: "int" } } });
  } finally {
    try { fs.unlinkSync(f); } catch {}
  }
}

test("openPty returns distinct usable descriptors", () => {
  const h = openPty(24, 80);
  for (const fd of [h.master, h.slave, h.slaveOut, h.slaveErr]) expect(fd).toBeGreaterThan(-1);
  expect(new Set([h.slave, h.slaveOut, h.slaveErr]).size).toBe(3);
  for (const fd of [h.master, h.slave, h.slaveOut, h.slaveErr]) { try { fs.closeSync(fd); } catch {} }
});

test("openPty honours the initial winsize", () => {
  const h = openPty(31, 121);
  const out = new Uint16Array(2);
  makeGetter().symbols.agmux_test_get(h.master, ptr(out), TIOCGWINSZ);
  expect([out[0], out[1]]).toEqual([31, 121]);
  for (const fd of [h.master, h.slave, h.slaveOut, h.slaveErr]) { try { fs.closeSync(fd); } catch {} }
});

// The header-free shim's struct layout must match the kernel's. A wrong layout
// would compile happily and silently resize to garbage.
test("setWinsize writes rows and cols the kernel agrees with", () => {
  const h = openPty(24, 80);
  expect(setWinsize(h.master, 42, 137)).toBe(0);
  const out = new Uint16Array(2);
  makeGetter().symbols.agmux_test_get(h.master, ptr(out), TIOCGWINSZ);
  expect([out[0], out[1]]).toEqual([42, 137]);
  for (const fd of [h.master, h.slave, h.slaveOut, h.slaveErr]) { try { fs.closeSync(fd); } catch {} }
});

test("setWinsize is callable repeatedly (the shim is cached, not rebuilt)", () => {
  const h = openPty(24, 80);
  for (const [r, c] of [[10, 20], [30, 40], [50, 60]] as const) {
    expect(setWinsize(h.master, r, c)).toBe(0);
  }
  const out = new Uint16Array(2);
  makeGetter().symbols.agmux_test_get(h.master, ptr(out), TIOCGWINSZ);
  expect([out[0], out[1]]).toEqual([50, 60]);
  for (const fd of [h.master, h.slave, h.slaveOut, h.slaveErr]) { try { fs.closeSync(fd); } catch {} }
});

test("setWinsize reports failure rather than throwing on a bad fd", () => {
  expect(setWinsize(-1, 24, 80)).toBe(-1);
});

test("importing the wrapper barrel exposes the config loaders", async () => {
  const m = await import("../src/index.ts");
  expect(typeof m.loadProfile).toBe("function");
});

// The reported crash: `agmux hub restart` died compiling C, because the wrapper
// barrel re-exports the PTY module next to the TOML config loaders and the
// compile ran at import time — so reading a TOML file needed a working C
// toolchain, and a macOS box whose SDK headers had gone missing could run no
// agmux command at all.
//
// Asserting that in-process proves nothing on a machine that can compile, so
// these run in a subprocess with TMPDIR pointed at a read-only directory: the
// shim cannot even write its .c file there, making the compile fail on ANY
// machine. Import must then still succeed AND stay silent — an eager compile
// would announce the failed shim to every `agmux hub restart` and `agmux ls`,
// which is the laziness this pins (the import merely not throwing is only the
// try/catch, and would hold either way).
function importIn(tmpdir: string, spec: string) {
  return Bun.spawnSync({
    cmd: [process.execPath, "-e", `await import(${JSON.stringify(spec)}); console.log("OK");`],
    env: { ...process.env, TMPDIR: tmpdir },
    cwd: path.join(import.meta.dir, ".."),
    stdout: "pipe", stderr: "pipe",
  });
}

function readonlyTmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "agmux-ro-"));
  fs.chmodSync(d, 0o500); // r-x: writing the shim's .c file is impossible
  return d;
}

test("the PTY module imports even when the shim cannot be built", () => {
  const d = readonlyTmp();
  try {
    const r = importIn(d, "./src/pty.ts");
    expect(r.stdout.toString()).toContain("OK");
    expect(r.exitCode).toBe(0);
    expect(r.stderr.toString()).toBe("");
  } finally {
    fs.chmodSync(d, 0o700); fs.rmSync(d, { recursive: true, force: true });
  }
});

test("the wrapper barrel imports even when the shim cannot be built", () => {
  const d = readonlyTmp();
  try {
    const r = importIn(d, "./src/index.ts");
    expect(r.stdout.toString()).toContain("OK");
    expect(r.exitCode).toBe(0);
    expect(r.stderr.toString()).toBe("");
  } finally {
    fs.chmodSync(d, 0o700); fs.rmSync(d, { recursive: true, force: true });
  }
});
