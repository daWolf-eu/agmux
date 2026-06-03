#!/usr/bin/env bun
import * as os from "node:os";
import * as path from "node:path";
import { runWrapper } from "../src/index.ts";
import { loadProfile, type ProfileConfig } from "../src/profile.ts";
import {
  AGMUX_CONFIG_SUBPATH,
  AGMUX_STATE_DIR_DEFAULT,
  AGMUX_HUB_URL_ENV,
} from "@agmux/protocol";

// Two invocation modes:
//  1) Profile mode: `agmux-wrap <profile_name>` — load profile from ~/.config/agmux/config.toml.
//  2) Inline mode:  env AGMUX_INLINE_PROFILE=<json> set → use it directly. argv[0] is a
//     descriptive label only (no config lookup). The CLI's `agmux run <cmd> [args]` uses this.
const argv = process.argv.slice(2);
const inlineJson = process.env.AGMUX_INLINE_PROFILE;

const stateDir = path.join(os.homedir(), AGMUX_STATE_DIR_DEFAULT);
const configPath = path.join(os.homedir(), AGMUX_CONFIG_SUBPATH);
const hubUrl = process.env[AGMUX_HUB_URL_ENV] ?? "http://127.0.0.1:0"; // CLI sets the real one

let profile: ProfileConfig;
let profileName: string | null;

if (inlineJson) {
  try {
    profile = JSON.parse(inlineJson) as ProfileConfig;
  } catch (e: any) {
    console.error(`agmux-wrap: AGMUX_INLINE_PROFILE is not valid JSON: ${e?.message ?? e}`);
    process.exit(2);
  }
  profileName = null;
} else {
  if (argv.length < 1) {
    console.error("usage: agmux-wrap <profile_name>");
    process.exit(2);
  }
  profileName = argv[0]!;
  profile = loadProfile(profileName, configPath);
}

const code = await runWrapper({ profile, profileName, stateDir, hubUrl, argv });
process.exit(code);
