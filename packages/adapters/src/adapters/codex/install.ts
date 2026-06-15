import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { InstallContext, InstallRecord, InstallStatus } from "../../core/types.ts";
import { CODEX_CAPABILITIES } from "./caps.ts";
import { MARKETPLACE_FILES, PLUGIN_VERSION, MARKETPLACE_NAME, PLUGIN_NAME } from "./plugin-files.ts";

export const ADAPTER_VERSION = "1";
const PLUGIN_REF = `${PLUGIN_NAME}@${MARKETPLACE_NAME}`; // "agmux@agmux"

// Install model (spec §2): ship an embedded plugin behind a LOCAL marketplace and
// drive Codex's official `codex plugin` commands, scoped to the target CODEX_HOME.
// The `codex` binary is invoked through an injectable runner so install logic is
// unit-testable without the real CLI/auth.

export interface CodexRunResult { code: number; stdout: string; stderr: string; }
export type CodexRunner = (args: string[], env: Record<string, string>) => CodexRunResult;

const defaultRunner: CodexRunner = (args, env) => {
  const r = cp.spawnSync("codex", args, { env: { ...process.env, ...env }, encoding: "utf8" });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

let runner: CodexRunner = defaultRunner;
// Test seam: inject a fake `codex` runner; pass null to restore the real one.
export function setCodexRunner(r: CodexRunner | null): void { runner = r ?? defaultRunner; }

// config-dir isolation (spec §6): explicit CLI override wins, then the profile's
// own CODEX_HOME, then the default. Mirrors Claude's CLAUDE_CONFIG_DIR resolution.
export function resolveConfigDir(ctx: InstallContext): string {
  return ctx.configDirOverride ?? ctx.profileEnv.CODEX_HOME ?? path.join(os.homedir(), ".codex");
}

export function marketplaceDir(stateDir: string): string {
  return path.join(stateDir, "codex", "marketplace");
}

function materialize(stateDir: string): string {
  const dest = marketplaceDir(stateDir);
  fs.rmSync(dest, { recursive: true, force: true }); // idempotent: refresh in place
  for (const f of MARKETPLACE_FILES) {
    const target = path.join(dest, f.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, f.content, { mode: f.mode });
  }
  return dest;
}

export function codexInstall(ctx: InstallContext): InstallRecord {
  const configDir = resolveConfigDir(ctx);
  const env = { CODEX_HOME: configDir };
  const mkt = materialize(ctx.stateDir);
  runner(["plugin", "marketplace", "add", mkt], env);
  runner(["plugin", "add", PLUGIN_REF], env);
  const configToml = path.join(configDir, "config.toml");
  return {
    agentKind: "codex",
    profile: ctx.profile,
    adapterVersion: ADAPTER_VERSION,
    isolationMode: "config-dir",
    capabilities: CODEX_CAPABILITIES,
    artifacts: [
      { kind: "config-key", path: configToml, detail: `plugin ${PLUGIN_REF}`, restore: null },
      { kind: "config-key", path: configToml, detail: `marketplace ${MARKETPLACE_NAME}`, restore: null },
    ],
  };
}

export function codexUninstall(ctx: InstallContext, _record: InstallRecord): void {
  const env = { CODEX_HOME: resolveConfigDir(ctx) };
  runner(["plugin", "remove", PLUGIN_REF], env);
  runner(["plugin", "marketplace", "remove", MARKETPLACE_NAME], env);
}

export function codexStatus(ctx: InstallContext): InstallStatus {
  const env = { CODEX_HOME: resolveConfigDir(ctx) };
  const { stdout } = runner(["plugin", "list"], env);
  const line = stdout.split("\n").find((l) => l.trim().startsWith(PLUGIN_REF));
  if (!line) return { installed: false, version: null, drift: false, runtimeGate: "hook-trust" };
  // Columns: `PLUGIN STATUS VERSION PATH`. After the ref, STATUS is "installed" or
  // "not installed" — test "not " first since it contains "installed" as a substring.
  const after = line.trim().slice(PLUGIN_REF.length).trim();
  if (!after.startsWith("installed")) {
    return { installed: false, version: null, drift: false, runtimeGate: "hook-trust" };
  }
  const reportedVersion = after.slice("installed".length).trim().split(/\s+/)[0] || null;
  const drift = reportedVersion !== null && reportedVersion !== PLUGIN_VERSION;
  // Hook activation may still be gated by Codex's hook-trust model at session start
  // (spec §7.3); kept until a live wrapped session proves hooks fire ungated.
  return { installed: true, version: ADAPTER_VERSION, drift, runtimeGate: "hook-trust" };
}
