#!/usr/bin/env bun
import * as os from "node:os";
import * as path from "node:path";
import { AGMUX_STATE_DIR_DEFAULT } from "@agmux/protocol";
import { ensureHubRunning } from "../src/hub-spawn.ts";
import { runCmd } from "../src/run.ts";
import { parseRunArgs } from "../src/parse-run.ts";
import { lsCmd } from "../src/ls.ts";
import { inspectCmd } from "../src/inspect.ts";
import { killCmd } from "../src/kill.ts";
import { attachCmd } from "../src/attach.ts";

const stateDir = path.join(os.homedir(), AGMUX_STATE_DIR_DEFAULT);
const hubBin = process.env.AGMUX_HUB_BIN ?? "agmux-hub";
const wrapBin = process.env.AGMUX_WRAP_BIN ?? "agmux-wrap";

const argv = process.argv.slice(2);
const verb = argv[0];

function usage(): never {
  console.error(`usage: agmux <verb> [args]
  run [--kind=<claude|codex>] <command> [args...]
  run -p <profile>
  ls [--live] [--all] [--agent <kind>] [--profile <name>]
  attach <id|prefix>
  kill <id|prefix> [--signal SIGTERM]
  inspect <id|prefix>`);
  process.exit(2);
}

async function main(): Promise<number> {
  if (!verb) usage();

  // Hub required for every verb. `run` would also accept a still-spawning hub
  // because the wrapper queues to disk; for simplicity here we ensure it for all.
  const hubUrl = await ensureHubRunning(stateDir, hubBin);

  switch (verb) {
    case "run": {
      const parsed = parseRunArgs(argv.slice(1));
      if (parsed.kind === "error") {
        console.error(parsed.message);
        return 2;
      }
      if (parsed.kind === "profile") {
        return runCmd({ kind: "profile", profileName: parsed.profileName, hubUrl, wrapBin });
      }
      return runCmd({
        kind: "inline",
        agent_kind: parsed.agent_kind,
        command: parsed.command,
        args: parsed.args,
        hubUrl, wrapBin,
      });
    }
    case "ls": {
      const live = argv.includes("--live");
      const all = argv.includes("--all");
      const agentIdx = argv.indexOf("--agent");
      const profileIdx = argv.indexOf("--profile");
      return lsCmd({
        live, all, hubUrl,
        agent: agentIdx >= 0 ? argv[agentIdx + 1] : undefined,
        profile: profileIdx >= 0 ? argv[profileIdx + 1] : undefined,
      });
    }
    case "attach": {
      const id = argv[1]; if (!id) usage();
      return attachCmd({ idOrPrefix: id, hubUrl, wrapBin });
    }
    case "kill": {
      const id = argv[1]; if (!id) usage();
      const sigIdx = argv.indexOf("--signal");
      const signal = sigIdx >= 0 ? argv[sigIdx + 1]! : "SIGTERM";
      return killCmd({ idOrPrefix: id, signal, hubUrl });
    }
    case "inspect": {
      const id = argv[1]; if (!id) usage();
      return inspectCmd({ idOrPrefix: id, hubUrl });
    }
    default:
      usage();
  }
}

process.exit(await main());
