import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";

// `agmux statusline` renders into tmux's status-format expansion: a non-zero
// exit or a stack trace on stderr just paints garbage into the user's status
// bar. These tests spawn the real CLI (not the unit-level statuslineCmd) so a
// future refactor that drops the try/catch in bin/agmux.ts, or the
// discoverHubUrl()===undefined branch, fails loudly instead of silently.

const repo = path.resolve(__dirname, "..", "..");
const cliScript = path.join(repo, "packages/cli/bin/agmux.ts");

function makeHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agmux-statusline-e2e-"));
}

function writeConfig(home: string, contents: string): void {
  const dir = path.join(home, ".config", "agmux");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "config.toml"), contents);
}

function writeHubPort(home: string, contents: string): void {
  const dir = path.join(home, ".agmux");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "hub.port"), contents);
}

// No "Error:" or " at <frame>" lines — the shape of an uncaught-exception dump.
function assertNoStackTrace(stderr: string): void {
  expect(stderr).not.toContain("Error:");
  expect(stderr).not.toMatch(/\n\s+at .+/);
}

async function runStatusline(home: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const env = { HOME: home, PATH: process.env.PATH ?? "" };
  const r = await $`bun ${cliScript} statusline`.env(env).nothrow().quiet();
  return { exitCode: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

test("bad config value + garbage hub.port -> marker, exit 0, no stack trace", async () => {
  const home = makeHome();
  writeConfig(home, `[statusline]\nmax = "three"\n`);
  writeHubPort(home, "not-a-port");

  const { exitCode, stdout, stderr } = await runStatusline(home);
  expect(exitCode).toBe(0);
  expect(stdout).toContain("agmux:");
  assertNoStackTrace(stderr);
}, 15000);

test("no config file, no hub.port -> marker, exit 0", async () => {
  const home = makeHome();

  const { exitCode, stdout, stderr } = await runStatusline(home);
  expect(exitCode).toBe(0);
  expect(stdout).toContain("agmux:");
  assertNoStackTrace(stderr);
}, 15000);

test("syntactically invalid TOML -> marker, exit 0", async () => {
  const home = makeHome();
  writeConfig(home, `[statusline\n`); // unterminated table header

  const { exitCode, stdout, stderr } = await runStatusline(home);
  expect(exitCode).toBe(0);
  expect(stdout).toContain("agmux:");
  assertNoStackTrace(stderr);
}, 15000);

test("hub.port points at a closed port -> marker, exit 0 (real fetch-rejects path)", async () => {
  const home = makeHome();
  writeHubPort(home, "1"); // valid integer, but port 1 refuses connections

  const { exitCode, stdout, stderr } = await runStatusline(home);
  expect(exitCode).toBe(0);
  expect(stdout).toContain("agmux:");
  assertNoStackTrace(stderr);
}, 15000);
