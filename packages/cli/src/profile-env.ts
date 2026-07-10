import * as os from "node:os";
import * as path from "node:path";
import { AGMUX_CONFIG_SUBPATH } from "@agmux/protocol";
import { loadProfile } from "@agmux/wrapper";

// Resolve a named profile's env from a specific config file. Returns undefined
// (never throws) when the config or profile is absent — a native session may
// carry an AGMUX_PROFILE that no longer exists.
export function loadProfileEnvFrom(name: string, configPath: string): Record<string, string> | undefined {
  try {
    return loadProfile(name, configPath).env;
  } catch {
    return undefined;
  }
}

// The default loader against the user's real config (~/.config/agmux/config.toml).
export function loadProfileEnv(name: string): Record<string, string> | undefined {
  return loadProfileEnvFrom(name, path.join(os.homedir(), AGMUX_CONFIG_SUBPATH));
}
