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
