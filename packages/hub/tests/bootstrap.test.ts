import { test, expect, beforeEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { atomicWritePortFile, readPidFile, writePidFile, isProcessAlive, acquireSingletonLock } from "../src/bootstrap.ts";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agmux-hub-test-"));
});

test("atomicWritePortFile writes via .tmp then rename", () => {
  const f = path.join(tmp, "hub.port");
  atomicWritePortFile(f, 51234);
  expect(fs.readFileSync(f, "utf8").trim()).toBe("51234");
  expect(fs.existsSync(f + ".tmp")).toBe(false);
});

test("writePidFile / readPidFile round-trip", () => {
  const f = path.join(tmp, "hub.pid");
  writePidFile(f, 99999);
  expect(readPidFile(f)).toBe(99999);
});

test("readPidFile returns null when missing", () => {
  expect(readPidFile(path.join(tmp, "nope"))).toBe(null);
});

test("isProcessAlive(self.pid) is true", () => {
  expect(isProcessAlive(process.pid)).toBe(true);
});

test("isProcessAlive(very-unlikely pid 2^31-1) is false", () => {
  expect(isProcessAlive(2147483646)).toBe(false);
});

test("acquireSingletonLock succeeds on a free path and records our pid", () => {
  const f = path.join(tmp, "hub.lock");
  const lock = acquireSingletonLock(f);
  expect(lock).not.toBeNull();
  expect(readPidFile(f)).toBe(process.pid);
  lock!.release();
});

test("acquireSingletonLock returns null when a live foreign process holds the lock", () => {
  const f = path.join(tmp, "hub.lock");
  const child = Bun.spawn(["sleep", "30"], { stdio: ["ignore", "ignore", "ignore"] });
  writePidFile(f, child.pid);
  try {
    expect(acquireSingletonLock(f)).toBeNull();
  } finally {
    child.kill();
  }
});

test("acquireSingletonLock steals a stale lock (holder pid dead)", () => {
  const f = path.join(tmp, "hub.lock");
  writePidFile(f, 2147483646); // dead pid
  const lock = acquireSingletonLock(f);
  expect(lock).not.toBeNull();
  expect(readPidFile(f)).toBe(process.pid);
  lock!.release();
});

test("release removes the lock so it can be re-acquired", () => {
  const f = path.join(tmp, "hub.lock");
  const a = acquireSingletonLock(f);
  expect(a).not.toBeNull();
  a!.release();
  expect(fs.existsSync(f)).toBe(false);
  const b = acquireSingletonLock(f);
  expect(b).not.toBeNull();
  b!.release();
});
