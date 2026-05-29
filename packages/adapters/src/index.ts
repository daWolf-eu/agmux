export * from "./core/index.ts";
import { createRegistry, type Registry } from "./core/registry.ts";
import { registerAll } from "./adapters/index.ts";

// The registry the CLI uses by default. v1: contains no providers (registerAll is
// empty), so `agmux emit`/`agmux adapter` degrade gracefully until a provider lands.
export function createDefaultRegistry(): Registry {
  const r = createRegistry();
  registerAll(r);
  return r;
}
