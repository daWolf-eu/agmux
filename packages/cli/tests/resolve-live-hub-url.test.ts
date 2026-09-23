import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveLiveHubUrl, discoverHubUrl } from "../src/emit.ts";

function stateDir(port?: number): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "agmux-state-"));
  if (port !== undefined) fs.writeFileSync(path.join(d, "hub.port"), `${port}\n`);
  return d;
}

test("reads the live port file", () => {
  expect(resolveLiveHubUrl({}, stateDir(54090))).toBe("http://127.0.0.1:54090");
});

test("falls back to AGMUX_HUB_URL when there is no local hub", () => {
  const env = { AGMUX_HUB_URL: "http://remote:9000" };
  expect(resolveLiveHubUrl(env, stateDir())).toBe("http://remote:9000");
});

test("null when neither a port file nor an override exists", () => {
  expect(resolveLiveHubUrl({}, stateDir())).toBeNull();
});

// The crux. The wrapper injects AGMUX_HUB_URL into every agent session, so a
// dash popup opened inside an agent pane carries a snapshot of the port the hub
// had when that session started. After `agmux hub restart` the port moves and
// that snapshot is stale — following it is what froze the dash and printed
// "hub down". For a long-lived subscriber the port file wins.
test("a stale inherited AGMUX_HUB_URL loses to the live port file", () => {
  const d = stateDir(54090);
  const stale = { AGMUX_HUB_URL: "http://127.0.0.1:51985" }; // pre-restart port
  expect(resolveLiveHubUrl(stale, d)).toBe("http://127.0.0.1:54090");
});

test("it picks up a port file rewritten under it", () => {
  const d = stateDir(1111);
  expect(resolveLiveHubUrl({}, d)).toBe("http://127.0.0.1:1111");
  fs.writeFileSync(path.join(d, "hub.port"), "2222\n");
  expect(resolveLiveHubUrl({}, d)).toBe("http://127.0.0.1:2222");
});

test("a malformed port file is ignored, not turned into a junk URL", () => {
  const d = stateDir();
  fs.writeFileSync(path.join(d, "hub.port"), "not-a-port\n");
  expect(resolveLiveHubUrl({}, d)).toBeNull();
  fs.writeFileSync(path.join(d, "hub.port"), "0\n");
  expect(resolveLiveHubUrl({}, d)).toBeNull();
});

// One-shot commands keep the opposite precedence: there the env var is a
// deliberate override, and the command is too short-lived to go stale.
test("discoverHubUrl still lets the env override win, unlike the live resolver", () => {
  const d = stateDir(54090);
  const env = { AGMUX_HUB_URL: "http://remote:9000" };
  expect(discoverHubUrl(env, d)).toBe("http://remote:9000");
  expect(resolveLiveHubUrl(env, d)).toBe("http://127.0.0.1:54090");
});
