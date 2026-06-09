import type { Adapter, InstallContext } from "@agmux/adapters";
import type { AgentKind } from "@agmux/protocol";

// Direct exec needs the plugin present, but `agmux run` MUST NOT write the user's
// Claude config without consent. So we only CHECK: if the plugin is missing/drifted,
// emit a one-line hint (the documented install command IS the consent path) and
// report not-ready, so the caller falls back to wrapped. Never installs, never throws.
export function adapterReadyOrHint(
  adapter: Adapter,
  ctx: InstallContext,
  kind: AgentKind,
  out: (line: string) => void,
): boolean {
  let st;
  try { st = adapter.status(ctx); } catch { return false; }
  if (st.installed && !st.drift) return true;
  const what = st.drift ? "outdated" : "not installed";
  out(`agmux: ${kind} adapter ${what} — native tracking off. Enable it with: agmux adapter install --kind ${kind}  (launching wrapped for now)`);
  return false;
}
