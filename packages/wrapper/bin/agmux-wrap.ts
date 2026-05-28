#!/usr/bin/env bun
import * as os from "node:os";
import * as path from "node:path";
import { runWrapper } from "../src/index.ts";
import { AGMUX_CONFIG_SUBPATH, AGMUX_STATE_DIR_DEFAULT, AGMUX_HUB_URL_ENV } from "@agmux/protocol";

// argv layout: agmux-wrap <profile_name> [-- ...]
const argv = process.argv.slice(2);
if (argv.length < 1) {
  console.error("usage: agmux-wrap <profile_name>");
  process.exit(2);
}
const profileName = argv[0]!;

const stateDir = path.join(os.homedir(), AGMUX_STATE_DIR_DEFAULT);
const configPath = path.join(os.homedir(), AGMUX_CONFIG_SUBPATH);
const hubUrl = process.env[AGMUX_HUB_URL_ENV] ?? "http://127.0.0.1:0"; // CLI sets the real one

const code = await runWrapper({ profileName, configPath, stateDir, hubUrl, argv });
process.exit(code);
