import { AGMUX_SESSION_ID_ENV, AGMUX_HUB_URL_ENV, AGMUX_PROFILE_ENV } from "@agmux/protocol";

// Build the env the agent child runs with. AGMUX_PROFILE is set only for a named
// profile — it is the runtime gate `env-gated` adapter installs key off (spec §6.1).
export function buildChildEnv(
  base: Record<string, string | undefined>,
  a: { sessionId: string; hubUrl: string; profileEnv: Record<string, string>; profileName: string | null },
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined) env[k] = v;
  Object.assign(env, a.profileEnv);
  env[AGMUX_SESSION_ID_ENV] = a.sessionId;
  env[AGMUX_HUB_URL_ENV] = a.hubUrl;
  if (a.profileName) env[AGMUX_PROFILE_ENV] = a.profileName;
  return env;
}

// Full env to forward to the inner wrapper when the outer wrapper re-execs into a
// new tmux window (outside-tmux launch). A new window inherits only the tmux SERVER
// env and runs the command with no login shell, so anything the user set for this
// launch (PATH tweaks, CLAUDE_CONFIG_DIR, …) is lost unless we carry it. The outer
// wrapper IS the launch and holds the exact ambient env, so full forwarding is the
// correct process-continuation behavior. This is transient tmux window env (process
// propagation), not persisted storage — the allowlist-only capture rule (which
// guards what we STORE) does not apply here.
export function reexecEnv(base: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined) out[k] = v;
  return out;
}
