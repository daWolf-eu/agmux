import type { Adapter } from "../../core/types.ts";
import { CLAUDE_SOURCES, CLAUDE_CAPABILITIES, CLAUDE_RELAUNCH_ENV_KEYS } from "./caps.ts";
import { normalizeClaude } from "./normalize.ts";
import { claudeResumePlan } from "./resume.ts";
import { claudeInstall, claudeUninstall, claudeStatus, ADAPTER_VERSION } from "./install.ts";

// The plugin payload is embedded code (plugin-files.ts) — no on-disk data files,
// no import.meta.dir, so the adapter behaves identically from source and from a
// compiled agmux binary.
export const claudeAdapter: Adapter = {
  agentKind: "claude",
  adapterVersion: ADAPTER_VERSION,
  relaunchEnvKeys: [...CLAUDE_RELAUNCH_ENV_KEYS],
  sources: () => CLAUDE_SOURCES,
  capabilities: () => CLAUDE_CAPABILITIES,
  install: claudeInstall,
  uninstall: claudeUninstall,
  status: claudeStatus,
  normalize: normalizeClaude,
  resumePlan: claudeResumePlan,
  nativeIdFromEnv: (env) => env.CLAUDE_CODE_SESSION_ID ?? null,
};
