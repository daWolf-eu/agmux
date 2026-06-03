import * as path from "node:path";
import type { Adapter } from "../../core/types.ts";
import { CLAUDE_SOURCES, CLAUDE_CAPABILITIES } from "./caps.ts";
import { normalizeClaude } from "./normalize.ts";
import { claudeResumePlan } from "./resume.ts";
import { claudePluginRunner, type PluginRunner } from "./runner.ts";
import { claudeInstall, claudeUninstall, claudeStatus, ADAPTER_VERSION } from "./install.ts";

export interface ClaudeAdapterDeps {
  runner?: PluginRunner;        // injected in tests; defaults to the real /plugin driver
  marketplacePath?: string;     // defaults to the static in-repo marketplace beside this module
}

export function createClaudeAdapter(deps: ClaudeAdapterDeps = {}): Adapter {
  const runner = deps.runner ?? claudePluginRunner();
  const marketplacePath = deps.marketplacePath ?? path.join(import.meta.dir, "marketplace");
  return {
    agentKind: "claude",
    adapterVersion: ADAPTER_VERSION,
    sources: () => CLAUDE_SOURCES,
    capabilities: () => CLAUDE_CAPABILITIES,
    install: (ctx) => claudeInstall(ctx, runner, marketplacePath),
    uninstall: (ctx) => claudeUninstall(ctx, runner),
    status: (ctx) => claudeStatus(ctx, runner),
    normalize: normalizeClaude,
    resumePlan: claudeResumePlan,
  };
}

export const claudeAdapter: Adapter = createClaudeAdapter();
