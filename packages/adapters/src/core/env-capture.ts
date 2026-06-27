// Allowlist-only env capture. Iterates the DECLARED key list and pulls present,
// non-empty values from the env. It never enumerates the environment, so an
// undeclared variable (a secret/token) is structurally impossible to capture.
export function pickEnv(
  keys: readonly string[],
  env: Record<string, string | undefined> = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of keys) {
    const v = env[k];
    if (v) out[k] = v;
  }
  return out;
}
