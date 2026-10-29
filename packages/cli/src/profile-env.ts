import * as os from "node:os";
import * as path from "node:path";
import { AGMUX_CONFIG_SUBPATH } from "@agmux/protocol";
import { loadProfile } from "@agmux/wrapper";
import type { ProfileLaunch } from "./relaunch.ts";

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

// Resolve a named profile's launch (command, args, env) from a specific config
// file, so a resume replays the profile's args too. Same never-throws contract.
export function loadProfileLaunchFrom(name: string, configPath: string): ProfileLaunch | undefined {
  try {
    const p = loadProfile(name, configPath);
    return { command: p.command, args: p.args, env: p.env };
  } catch {
    return undefined;
  }
}

export function loadProfileLaunch(name: string): ProfileLaunch | undefined {
  return loadProfileLaunchFrom(name, path.join(os.homedir(), AGMUX_CONFIG_SUBPATH));
}
