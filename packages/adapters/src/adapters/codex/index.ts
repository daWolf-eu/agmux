import type { Adapter } from "../../core/types.ts";
import { CODEX_SOURCES, CODEX_CAPABILITIES } from "./caps.ts";
import { normalizeCodex } from "./normalize.ts";
import { codexResumePlan } from "./resume.ts";
import { codexInstall, codexUninstall, codexStatus, ADAPTER_VERSION } from "./install.ts";

// The plugin payload is embedded code (plugin-files.ts) materialized at install
// time — no on-disk data files, so the adapter behaves identically from source and
// from a compiled agmux binary. Codex exposes no native session-id env var, so its
// identity comes from hook STDIN (spec §5.3) via nativeIdFromStdin — this lets a
// bare `codex` launch self-register without the wrapper's AGMUX_SESSION_ID claim.
export const codexAdapter: Adapter = {
  agentKind: "codex",
  adapterVersion: ADAPTER_VERSION,
  relaunchEnvKeys: [],
  sources: () => CODEX_SOURCES,
  capabilities: () => CODEX_CAPABILITIES,
  install: codexInstall,
  uninstall: codexUninstall,
  status: codexStatus,
  normalize: normalizeCodex,
  resumePlan: codexResumePlan,
  nativeIdFromStdin: (raw) => {
    const id = (raw as { session_id?: unknown } | null)?.session_id;
    return typeof id === "string" && id !== "" ? id : null;
  },
};
