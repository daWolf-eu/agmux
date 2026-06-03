import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { InstallContext, InstallRecord, InstallStatus } from "../../core/types.ts";
import { CLAUDE_CAPABILITIES } from "./caps.ts";
import { PLUGIN_FILES, PLUGIN_VERSION } from "./plugin-files.ts";

export const ADAPTER_VERSION = "1";

// Install model: a "skills-directory plugin" (official, live since claude ~2.1).
// Writing the plugin into <configDir>/skills/agmux/ makes Claude auto-load it as
// `agmux@skills-dir` on the next session — no marketplace, no `claude` binary,
// no tokens. Install/uninstall are pure filesystem operations owned by agmux;
// the payload is embedded code (plugin-files.ts), so this also works from a
// compiled agmux binary.

// config-dir isolation (spec §6): explicit CLI override wins, then the profile's
// own CLAUDE_CONFIG_DIR, then the default. All install state lives under this dir.
export function resolveConfigDir(ctx: InstallContext): string {
  return ctx.configDirOverride ?? ctx.profileEnv.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
}

export function skillsPluginDir(configDir: string): string {
  return path.join(configDir, "skills", "agmux");
}

function readInstalledVersion(pluginDir: string): string | null {
  const manifest = path.join(pluginDir, ".claude-plugin", "plugin.json");
  if (!fs.existsSync(manifest)) return null;
  try { return JSON.parse(fs.readFileSync(manifest, "utf8")).version ?? null; } catch { return null; }
}

export function claudeInstall(ctx: InstallContext): InstallRecord {
  const dest = skillsPluginDir(resolveConfigDir(ctx));
  fs.rmSync(dest, { recursive: true, force: true }); // idempotent: refresh in place
  for (const f of PLUGIN_FILES) {
    const target = path.join(dest, f.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, f.content, { mode: f.mode });
  }
  return {
    agentKind: "claude",
    profile: ctx.profile,
    adapterVersion: ADAPTER_VERSION,
    isolationMode: "config-dir",
    capabilities: CLAUDE_CAPABILITIES,
    artifacts: [{ kind: "file", path: dest, detail: "skills-dir plugin agmux@skills-dir" }],
  };
}

export function claudeUninstall(_ctx: InstallContext, record: InstallRecord): void {
  for (const a of record.artifacts) {
    if (a.kind === "file") fs.rmSync(a.path, { recursive: true, force: true });
  }
}

export function claudeStatus(ctx: InstallContext): InstallStatus {
  const dest = skillsPluginDir(resolveConfigDir(ctx));
  const installedVersion = readInstalledVersion(dest);
  const installed = installedVersion !== null;
  const drift = installed && installedVersion !== PLUGIN_VERSION;
  // Hook activation may still be gated by Claude's trust model at session start
  // (spec §7.1); kept until a live wrapped session proves hooks fire ungated.
  return { installed, version: installed ? ADAPTER_VERSION : null, drift, runtimeGate: "hook-trust" };
}
