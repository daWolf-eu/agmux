import type { Adapter } from "../../core/types.ts";
import { CODEX_SOURCES, CODEX_CAPABILITIES } from "./caps.ts";
import { normalizeCodex } from "./normalize.ts";
import { codexResumePlan } from "./resume.ts";
import { codexInstall, codexUninstall, codexStatus, ADAPTER_VERSION } from "./install.ts";

// The plugin payload is embedded code (plugin-files.ts) materialized at install
// time — no on-disk data files, so the adapter behaves identically from source and
// from a compiled agmux binary. nativeIdFromEnv is omitted: Codex exposes no native
// session-id env var, so identity is taken from hook stdin (spec §5.3).
export const codexAdapter: Adapter = {
  agentKind: "codex",
  adapterVersion: ADAPTER_VERSION,
  sources: () => CODEX_SOURCES,
  capabilities: () => CODEX_CAPABILITIES,
  install: codexInstall,
  uninstall: codexUninstall,
  status: codexStatus,
  normalize: normalizeCodex,
  resumePlan: codexResumePlan,
};
