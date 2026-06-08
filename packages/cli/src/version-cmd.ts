import { AGMUX_VERSION } from "@agmux/protocol";
import { createDefaultRegistry, type Registry } from "@agmux/adapters";

// `agmux -v`: the product version plus each registered adapter's version (so a
// new provider shows up here automatically). Plugin/install state per provider
// lives in `agmux adapter status`. Pure + injectable registry for testing.
export function formatVersion(registry: Registry = createDefaultRegistry()): string {
  const adapters = registry.kinds()
    .map((k) => `${k} v${registry.lookup(k)!.adapterVersion}`)
    .join(", ");
  return `agmux ${AGMUX_VERSION}\nadapters: ${adapters || "(none)"}`;
}
