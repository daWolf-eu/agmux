import type { Registry } from "../core/registry.ts";

// THE per-provider wiring seam. Each per-provider subagent (see the Phase-2 plan's
// "Per-Provider Work Packages" appendix) adds exactly one import + one register()
// call here, and nothing else in core changes. Empty in v1 by design — the
// framework ships with zero concrete providers.
export function registerAll(_registry: Registry): void {
  // e.g. _registry.register(claudeAdapter);
}
