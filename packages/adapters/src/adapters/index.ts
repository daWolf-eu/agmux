import type { Registry } from "../core/registry.ts";
import { claudeAdapter } from "./claude/index.ts";
import { codexAdapter } from "./codex/index.ts";
import { piAdapter } from "./pi/index.ts";

// THE per-provider wiring seam. Each provider adds one import + one register()
// call here, and nothing else in core changes.
export function registerAll(registry: Registry): void {
  registry.register(claudeAdapter);
  registry.register(codexAdapter);
  registry.register(piAdapter);
}
