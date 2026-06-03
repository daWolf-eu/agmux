import { spawnSync } from "node:child_process";

// The official plugin surface is the `/plugin` slash command, driven headlessly
// via `claude -p "..."` and scoped by CLAUDE_CONFIG_DIR (spec §2). No standalone
// `claude plugin` CLI exists. The spawner is injectable so the command wiring is
// unit-testable without a live Claude.
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
  const slash = (configDir: string, command: string) => spawn(claudeBin, ["-p", command], configDir);
  return {
    marketplaceAdd(configDir, marketplacePath) { slash(configDir, `/plugin marketplace add ${marketplacePath}`); },
    install(configDir, ref) { slash(configDir, `/plugin install ${ref}`); },
    uninstall(configDir, ref) { slash(configDir, `/plugin uninstall ${ref}`); },
    isInstalled(configDir, ref) {
      const { out } = slash(configDir, `/plugin list --json`);
      try {
        const list = JSON.parse(out);
        return Array.isArray(list) && list.some((p: any) => `${p.name}@${p.marketplace}` === ref && p.enabled !== false);
      } catch {
        return out.includes(ref); // read-only fallback if --json is unavailable (spec §7.2)
      }
    },
  };
}
