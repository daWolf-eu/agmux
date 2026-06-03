import type { PluginRunner } from "../../../src/adapters/claude/runner.ts";

// In-memory PluginRunner: install state keyed by (configDir, pluginRef). Lets the
// adapter's install/status/uninstall (and the conformance roundtrip) run without a
// live Claude.
export function fakePluginRunner(): PluginRunner {
  const installed = new Set<string>();
  const key = (configDir: string, ref: string) => `${configDir}::${ref}`;
  return {
    marketplaceAdd() {},
    install(configDir, ref) { installed.add(key(configDir, ref)); },
    uninstall(configDir, ref) { installed.delete(key(configDir, ref)); },
    isInstalled(configDir, ref) { return installed.has(key(configDir, ref)); },
  };
}
