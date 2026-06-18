import type { Adapter } from "../../core/types.ts";
import { PI_SOURCES, PI_CAPABILITIES } from "./caps.ts";
import { normalizePi } from "./normalize.ts";
import { piResumePlan } from "./resume.ts";
import { piInstall, piUninstall, piStatus, ADAPTER_VERSION } from "./install.ts";

// PI (pi.dev). Install is a pure filesystem drop of an embedded extension
// (extension-files.ts) into <configDir>/extensions/ — no marketplace, no `pi`
// binary. PI exposes no native session-id env var, so identity comes from hook
// STDIN (spec §5) via nativeIdFromStdin — the session-file UUID the extension
// emits. This lets a bare `pi` launch self-register without the wrapper's claim.
export const piAdapter: Adapter = {
  agentKind: "pi",
  adapterVersion: ADAPTER_VERSION,
  sources: () => PI_SOURCES,
  capabilities: () => PI_CAPABILITIES,
  install: piInstall,
  uninstall: piUninstall,
  status: piStatus,
  normalize: normalizePi,
  resumePlan: piResumePlan,
  nativeIdFromStdin: (raw) => {
    const id = (raw as { session_id?: unknown } | null)?.session_id;
    return typeof id === "string" && id !== "" ? id : null;
  },
};
