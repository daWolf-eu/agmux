#!/usr/bin/env bun
import * as os from "node:os";
import * as path from "node:path";
import { AGMUX_STATE_DIR_DEFAULT, AGMUX_CONFIG_SUBPATH } from "@agmux/protocol";
import { ensureHubRunning } from "../src/hub-spawn.ts";
import { runCmd } from "../src/run.ts";
import { parseRunArgs } from "../src/parse-run.ts";
import { lsCmd } from "../src/ls.ts";
import { inspectCmd } from "../src/inspect.ts";
import { killCmd } from "../src/kill.ts";
import { attachCmd } from "../src/attach.ts";
import { runEmit } from "../src/emit.ts";
import { runAdapterCmd } from "../src/adapter-cmd.ts";
import { runHubCmd } from "../src/hub-cmd.ts";
import { formatVersion } from "../src/version-cmd.ts";
import { createDefaultRegistry } from "@agmux/adapters";
import { decideLaunchMode } from "../src/launch-mode.ts";
import { adapterReadyOrHint } from "../src/adapter-ready.ts";
import { loadProfile, loadLsConfig, type LsConfig } from "@agmux/wrapper";
import { parseLsArgs } from "../src/parse-ls.ts";

const stateDir = path.join(os.homedir(), AGMUX_STATE_DIR_DEFAULT);
const hubBin = process.env.AGMUX_HUB_BIN ?? "agmux-hub";
const wrapBin = process.env.AGMUX_WRAP_BIN ?? "agmux-wrap";

const argv = process.argv.slice(2);
const verb = argv[0];

function usage(): never {
  console.error(`usage: agmux <verb> [args]
  run [placement] [--wrapped] [--kind=<claude|codex>] <command> [args...]
  run [placement] [--wrapped] -p <profile>
    placement: -d/--detach (default --new-pane) | --new-pane | --new-window | --new-session
    --wrapped   force the PTY wrapper (default: direct exec when the agent has an adapter)
  ls [-n <num>|--all] [--sort <started|activity>] [--asc|--desc] [-r/--reverse]
     [--status <active|open|closed|s1,s2,...>] [--live] [--agent <kind>] [--profile <name>]
     defaults configurable in ~/.config/agmux/config.toml under [ls]
  attach <id|prefix>
  kill <id|prefix> [--signal SIGTERM]
  inspect <id|prefix>
  adapter list|install|status|uninstall (<profile> | --kind <agent_kind>) [--config-dir <path>]
  hub status|restart       inspect / gracefully roll the background hub
  emit ...   (runtime callback; not user-facing)
  -v, --version            print agmux + adapter versions`);
  process.exit(2);
}

async function main(): Promise<number> {
  if (verb === "-v" || verb === "--version" || verb === "version") {
    console.log(formatVersion());
    return 0; // no hub needed
  }
  if (!verb) usage();

  if (verb === "emit") {
    const chunks: Buffer[] = [];
    for await (const c of Bun.stdin.stream()) chunks.push(Buffer.from(c));
    const stdin = Buffer.concat(chunks).toString("utf8");
    await runEmit(argv.slice(1), {
      registry: createDefaultRegistry(),
      env: process.env,
      stdin,
      host: os.hostname(),
      stateDir,
    });
    return 0; // always 0 — never break the agent's surface
  }

  if (verb === "adapter") {
    const configPath = path.join(os.homedir(), AGMUX_CONFIG_SUBPATH);
    return runAdapterCmd(argv.slice(1), {
      registry: createDefaultRegistry(),
      stateDir,
      configPath,
      agmuxEmitPath: `${process.env.AGMUX_BIN ?? "agmux"} emit`,
      out: (s) => console.log(s),
    });
  }

  // `hub` manages the daemon itself (status must not spawn one) — handle before
  // the ensureHubRunning gate below.
  if (verb === "hub") {
    return runHubCmd(argv.slice(1), { stateDir, hubBin, out: (s) => console.log(s) });
  }

  // Hub required for every verb. `run` would also accept a still-spawning hub
  // because the wrapper queues to disk; for simplicity here we ensure it for all.
  const hubUrl = await ensureHubRunning(stateDir, hubBin);

  switch (verb) {
    case "run": {
      const parsed = parseRunArgs(argv.slice(1));
      if (parsed.kind === "error") { console.error(parsed.message); return 2; }

      const registry = createDefaultRegistry();
      const agmuxBin = process.env.AGMUX_BIN ?? "agmux";
      const configPath = path.join(os.homedir(), AGMUX_CONFIG_SUBPATH);

      // Resolve the agent kind + profile env to decide direct-vs-wrapped. Inline
      // mode names its kind directly; profile mode reads it from the profile config.
      // A profile that fails to load (missing/invalid) → leave kind undefined so we
      // fall back to wrapped; the wrapper will surface the real profile error.
      let kind: "claude" | "codex" | undefined;
      let profileEnv: Record<string, string> = {};
      if (parsed.kind === "inline") {
        kind = parsed.agent_kind;
      } else {
        try { const p = loadProfile(parsed.profileName, configPath); kind = p.agent_kind; profileEnv = p.env; }
        catch { kind = undefined; }
      }

      const adapter = kind ? registry.lookup(kind) : undefined;
      let mode = decideLaunchMode({ wrapped: parsed.wrapped, hasAdapter: !!adapter });

      // Direct exec needs the plugin present; we NEVER install without consent.
      // If it isn't ready, adapterReadyOrHint prints the install hint and we fall
      // back to wrapped (tracked, no config writes).
      if (mode === "direct" && adapter && kind) {
        const ready = adapterReadyOrHint(adapter, {
          agentKind: kind,
          profile: parsed.kind === "profile" ? parsed.profileName : null,
          profileEnv,
          agmuxEmitPath: `${agmuxBin} emit`,
          stateDir,
          configDirOverride: null,
        }, kind, (s) => console.error(s));
        if (!ready) mode = "wrapped";
      }

      if (parsed.kind === "profile") {
        return runCmd({
          kind: "profile", profileName: parsed.profileName,
          placement: parsed.placement, detach: parsed.detach, hubUrl, wrapBin, mode,
        }, agmuxBin);
      }
      return runCmd({
        kind: "inline", agent_kind: parsed.agent_kind, command: parsed.command, args: parsed.args,
        placement: parsed.placement, detach: parsed.detach, hubUrl, wrapBin, mode,
      }, agmuxBin);
    }
    case "ls": {
      const configPath = path.join(os.homedir(), AGMUX_CONFIG_SUBPATH);
      let lsDefaults: LsConfig;
      try { lsDefaults = loadLsConfig(configPath); }
      catch (e) { console.error(e instanceof Error ? e.message : String(e)); return 2; }
      const parsed = parseLsArgs(argv.slice(1), lsDefaults);
      if (parsed.kind === "error") { console.error(parsed.message); return 2; }
      return lsCmd({ ...parsed.opts, hubUrl });
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
