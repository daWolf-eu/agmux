import { test, expect, beforeEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { atomicWritePortFile, readPidFile, writePidFile, isProcessAlive } from "../src/bootstrap.ts";

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
