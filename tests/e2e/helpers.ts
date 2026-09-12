import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface TestEnv { root: string; stateDir: string; configPath: string; hubBin: string; wrapBin: string; cliBin: string; }

// Every env handed out and not yet torn down. A test that throws mid-body never
// reaches its own cleanup, so teardown is driven from afterEach via
// cleanupAllTestEnvs() rather than from the test body.
const liveEnvs = new Set<TestEnv>();
let exitHookInstalled = false;

export function makeTestEnv(): TestEnv {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agmux-e2e-"));
  const stateDir = path.join(root, ".agmux");
  fs.mkdirSync(stateDir, { recursive: true });
  const configDir = path.join(root, ".config", "agmux");
  fs.mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, "config.toml");
  fs.writeFileSync(configPath, `
[profiles.echo]
agent_kind = "claude"
command = "sh"
args = ["-c", "while true; do sleep 1; echo .; done"]
`);
  const repo = path.resolve(__dirname, "..", "..");
  const binDir = path.join(root, "bin");
  fs.mkdirSync(binDir, { recursive: true });

  const hubScript = path.join(repo, "packages/hub/bin/agmux-hub.ts");
  const wrapScript = path.join(repo, "packages/wrapper/bin/agmux-wrap.ts");
  const cliScript = path.join(repo, "packages/cli/bin/agmux.ts");

  const hubBin = path.join(binDir, "agmux-hub");
  const wrapBin = path.join(binDir, "agmux-wrap");
  const cliBin = path.join(binDir, "agmux");

  // Shims embed HOME so they work correctly even when launched from a bare tmux
  // session that doesn't inherit the caller's env (tmux uses its own server env).
  const envLine = [
    `export HOME=${JSON.stringify(root)}`,
    `export XDG_CONFIG_HOME=${JSON.stringify(path.join(root, ".config"))}`,
    `export AGMUX_HUB_BIN=${JSON.stringify(hubBin)}`,
    `export AGMUX_WRAP_BIN=${JSON.stringify(wrapBin)}`,
  ].join("\n");

  fs.writeFileSync(hubBin, `#!/bin/sh\n${envLine}\nexec bun ${hubScript} "$@"\n`);
  fs.chmodSync(hubBin, 0o755);

  fs.writeFileSync(wrapBin, `#!/bin/sh\n${envLine}\nexec bun ${wrapScript} "$@"\n`);
  fs.chmodSync(wrapBin, 0o755);

  fs.writeFileSync(cliBin, `#!/bin/sh\n${envLine}\nexec bun ${cliScript} "$@"\n`);
  fs.chmodSync(cliBin, 0o755);

  const env: TestEnv = { root, stateDir, configPath, hubBin, wrapBin, cliBin };
  liveEnvs.add(env);
  installExitHook();
  return env;
}

function readPid(file: string): number | null {
  try {
    const n = Number(fs.readFileSync(file, "utf8").trim());
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch { return null; }
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === "EPERM"; }
}

/**
 * Terminate the hub this env spawned. The pid is read from the env's OWN
 * temp stateDir, so there is no path by which this reaches the developer's
 * real hub at ~/.agmux/hub.pid.
 *
 * Synchronous throughout so the same code serves both afterEach and the
 * process-exit safety net below, where async work would not run.
 */
function killHub(stateDir: string): void {
  const pid = readPid(path.join(stateDir, "hub.pid"));
  if (pid === null || !isAlive(pid)) return;
  try { process.kill(pid, "SIGTERM"); } catch { return; }
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return;
    Bun.sleepSync(50);
  }
  try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
}

/** Tear down one env: its hub, then its temp tree. Never throws. */
export function cleanupTestEnv(env: TestEnv): void {
  try { killHub(env.stateDir); } catch { /* best effort */ }
  try { fs.rmSync(env.root, { recursive: true, force: true }); } catch { /* best effort */ }
  liveEnvs.delete(env);
}

/** Tear down every env this file has handed out. Call from afterEach. */
export function cleanupAllTestEnvs(): void {
  for (const env of [...liveEnvs]) cleanupTestEnv(env);
}

// Safety net for the paths afterEach cannot cover — a crashed or timed-out
// runner. Sync-only by necessity: nothing async runs during 'exit'.
function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", () => { try { cleanupAllTestEnvs(); } catch { /* exiting anyway */ } });
}

export async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("waitFor timed out");
}

/**
 * Pre-spawn a single hub and wait until it answers, BEFORE launching the
 * tmux/wrapper activity. Otherwise the bare `ls` polling and the wrapper both
 * race to first-spawn a hub; under `bun test` CPU contention several `bun`
 * cold-starts pile up and the spawner's patience can lapse. Warming one hub
 * makes every later `ls` hit a live daemon instantly.
 */
export async function warmHub(cliBin: string, baseEnv: Record<string, string>): Promise<void> {
  const { $ } = await import("bun");
  await waitFor(async () => {
    const r = await $`${cliBin} ls`.env(baseEnv).nothrow().quiet();
    return r.exitCode === 0;
  }, 15000);
}
