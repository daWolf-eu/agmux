import { spawnSync } from "node:child_process";

// The official plugin surface is the first-class `claude plugin` CLI
// (marketplace add / install / uninstall / list --json), which runs
// non-interactively WITHOUT spawning a Claude session, scoped by
// CLAUDE_CONFIG_DIR (live-verified against claude 2.1.156). The spawner is
// injectable so the command wiring is unit-testable without a live Claude.
export type Spawner = (bin: string, args: string[], configDir: string) => { code: number; out: string };

export interface PluginRunner {
  marketplaceAdd(configDir: string, marketplacePath: string): void;
  install(configDir: string, pluginRef: string): void;
  uninstall(configDir: string, pluginRef: string): void;
  isInstalled(configDir: string, pluginRef: string): boolean;
}

const defaultSpawn: Spawner = (bin, args, configDir) => {
  const r = spawnSync(bin, args, { env: { ...process.env, CLAUDE_CONFIG_DIR: configDir }, encoding: "utf8" });
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};

export function claudePluginRunner(claudeBin = "claude", spawn: Spawner = defaultSpawn): PluginRunner {
  const cli = (configDir: string, args: string[]) => spawn(claudeBin, ["plugin", ...args], configDir);
  return {
    marketplaceAdd(configDir, marketplacePath) { cli(configDir, ["marketplace", "add", marketplacePath]); },
    install(configDir, ref) { cli(configDir, ["install", ref]); },
    uninstall(configDir, ref) { cli(configDir, ["uninstall", ref]); },
    isInstalled(configDir, ref) {
      const { out } = cli(configDir, ["list", "--json"]);
      try {
        // Live-verified shape: [{ id: "name@marketplace", version, scope, enabled, installPath, ... }]
        const list = JSON.parse(out);
        return Array.isArray(list) && list.some((p: any) => p.id === ref && p.enabled !== false);
      } catch {
        return out.includes(ref); // read-only fallback if --json output is ever non-JSON (spec §7.2)
      }
    },
  };
}
