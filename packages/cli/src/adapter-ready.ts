import type { Adapter, InstallContext } from "@agmux/adapters";
import type { AgentKind } from "@agmux/protocol";

// The env a launch's adapter is checked against and a direct agent runs with:
// the adapter's relaunch keys (claude: CLAUDE_CONFIG_DIR) taken from the process
// env, under a profile's own env. The keys are a strict allowlist, never the
// whole environment.
export function launchEnv(
  adapter: Pick<Adapter, "relaunchEnvKeys">,
  processEnv: Record<string, string | undefined>,
  profileEnv: Record<string, string> = {},
): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const k of adapter.relaunchEnvKeys) {
    const v = processEnv[k];
    if (v) picked[k] = v;
  }
  return { ...picked, ...profileEnv };
}

// Direct exec needs the plugin present, but `agmux run` MUST NOT write the user's
// Claude config without consent. So we only CHECK: if the plugin is missing/drifted,
// emit a one-line hint (the documented install command IS the consent path) and
// report not-ready, so the caller falls back to wrapped. Never installs, never throws.
// strict (--direct): no fallback; the hint names the config dir that was checked.
export function adapterReadyOrHint(
  adapter: Adapter,
  ctx: InstallContext,
  kind: AgentKind,
  out: (line: string) => void,
  strict = false,
): boolean {
  let st;
  try { st = adapter.status(ctx); }
  catch (e) {
    if (strict) out(`agmux run --direct: cannot read the ${kind} adapter status: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
  if (st.installed && !st.drift) return true;
  const what = st.drift ? "outdated" : "not installed";
  if (strict) {
    const dir = st.configDir;
    out(dir
      ? `agmux run --direct: ${kind} adapter ${what} in ${dir}; cannot launch direct. Install it with: agmux adapter install --kind ${kind} --config-dir ${dir}`
      : `agmux run --direct: ${kind} adapter ${what}; cannot launch direct. Install it with: agmux adapter install --kind ${kind}`);
    return false;
  }
  out(`agmux: ${kind} adapter ${what} — native tracking off. Enable it with: agmux adapter install --kind ${kind}  (launching wrapped for now)`);
  return false;
}
