import * as os from "node:os";
import * as path from "node:path";
import type { InstallContext, InstallRecord, InstallStatus } from "../../core/types.ts";
import type { PluginRunner } from "./runner.ts";
import { CLAUDE_CAPABILITIES } from "./caps.ts";

export const PLUGIN_REF = "agmux@agmux";
export const ADAPTER_VERSION = "1";

// config-dir isolation (spec §6): the profile resolves to its own CLAUDE_CONFIG_DIR;
// the bare target uses the default. All install state lives under this dir.
export function resolveConfigDir(ctx: InstallContext): string {
  return ctx.profileEnv.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
}

export function claudeInstall(ctx: InstallContext, runner: PluginRunner, marketplacePath: string): InstallRecord {
  const configDir = resolveConfigDir(ctx);
  runner.marketplaceAdd(configDir, marketplacePath);
  runner.install(configDir, PLUGIN_REF);
  const settings = path.join(configDir, "settings.json");
  return {
    agentKind: "claude",
    profile: ctx.profile,
    adapterVersion: ADAPTER_VERSION,
    isolationMode: "config-dir",
    capabilities: CLAUDE_CAPABILITIES,
    artifacts: [
      { kind: "config-key", path: settings, detail: `plugin ${PLUGIN_REF}`, restore: null },
      { kind: "config-key", path: settings, detail: "marketplace agmux", restore: null },
    ],
  };
}

export function claudeUninstall(ctx: InstallContext, runner: PluginRunner): void {
  runner.uninstall(resolveConfigDir(ctx), PLUGIN_REF);
}

export function claudeStatus(ctx: InstallContext, runner: PluginRunner): InstallStatus {
  const installed = runner.isInstalled(resolveConfigDir(ctx), PLUGIN_REF);
  // Plugin trust may gate hook activation even when installed+enabled (spec §7.1).
  return { installed, version: installed ? ADAPTER_VERSION : null, drift: false, runtimeGate: "hook-trust" };
}
