import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface TestEnv { stateDir: string; configPath: string; hubBin: string; wrapBin: string; cliBin: string; }

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

  return { stateDir, configPath, hubBin, wrapBin, cliBin };
}

export async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("waitFor timed out");
}
