import * as path from "node:path";
import type { Adapter } from "../../core/types.ts";
import { CLAUDE_SOURCES, CLAUDE_CAPABILITIES } from "./caps.ts";
import { normalizeClaude } from "./normalize.ts";
import { claudeResumePlan } from "./resume.ts";
import { claudeInstall, claudeUninstall, claudeStatus, ADAPTER_VERSION } from "./install.ts";

export interface ClaudeAdapterDeps {
  pluginSourceDir?: string; // defaults to the static in-repo plugin beside this module
}

export function createClaudeAdapter(deps: ClaudeAdapterDeps = {}): Adapter {
  const pluginSourceDir = deps.pluginSourceDir ?? path.join(import.meta.dir, "plugin");
  return {
    agentKind: "claude",
    adapterVersion: ADAPTER_VERSION,
    sources: () => CLAUDE_SOURCES,
    capabilities: () => CLAUDE_CAPABILITIES,
    install: (ctx) => claudeInstall(ctx, pluginSourceDir),
    uninstall: (ctx, record) => claudeUninstall(ctx, record),
    status: (ctx) => claudeStatus(ctx, pluginSourceDir),
    normalize: normalizeClaude,
    resumePlan: claudeResumePlan,
  };
}

export const claudeAdapter: Adapter = createClaudeAdapter();
