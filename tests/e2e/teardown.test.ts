import { test, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTestEnv, cleanupTestEnv, cleanupAllTestEnvs } from "./helpers.ts";

afterEach(() => cleanupAllTestEnvs());

// A Bun.spawn child stays a zombie until reaped, and kill(pid, 0) still
// succeeds on a zombie — so liveness here is read from the child handle, not
// from a signal probe. Real hubs are spawned detached and reaped by init.
function spawnStandIn() {
  return Bun.spawn(["sleep", "60"], { stdout: "ignore", stderr: "ignore" });
}

test("teardown removes the env's temp tree", () => {
  const env = makeTestEnv();
  expect(fs.existsSync(env.root)).toBe(true);
  cleanupTestEnv(env);
  expect(fs.existsSync(env.root)).toBe(false);
});

test("teardown kills the hub recorded in the env's own state dir", async () => {
  const env = makeTestEnv();

  // Stand in for a spawned hub: a real child process whose pid is written to
  // the env's hub.pid exactly as ensureHubRunning would.
  const child = spawnStandIn();
  fs.writeFileSync(path.join(env.stateDir, "hub.pid"), `${child.pid}\n`);
  expect(child.exitCode).toBeNull();

  cleanupTestEnv(env);
  await child.exited;
  expect(child.signalCode).toBe("SIGTERM");
});

test("teardown is safe when no hub was ever spawned", () => {
  const env = makeTestEnv();
  expect(() => cleanupTestEnv(env)).not.toThrow();
});

test("teardown never signals a pid outside its own state dir", async () => {
  const env = makeTestEnv();
  const other = spawnStandIn();
  // A hub.pid belonging to a DIFFERENT env must not be reachable from this one.
  const stranger = makeTestEnv();
  fs.writeFileSync(path.join(stranger.stateDir, "hub.pid"), `${other.pid}\n`);

  cleanupTestEnv(env);
  expect(other.exitCode).toBeNull();   // untouched — not this env's hub

  cleanupTestEnv(stranger);
  await other.exited;
  expect(other.signalCode).toBe("SIGTERM");
});

test("cleanupAllTestEnvs drains every outstanding env", () => {
  const a = makeTestEnv();
  const b = makeTestEnv();
  cleanupAllTestEnvs();
  expect(fs.existsSync(a.root)).toBe(false);
  expect(fs.existsSync(b.root)).toBe(false);
});
