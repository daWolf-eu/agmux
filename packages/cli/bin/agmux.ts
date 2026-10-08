#!/usr/bin/env bun
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AGMUX_STATE_DIR_DEFAULT, AGMUX_CONFIG_SUBPATH } from "@agmux/protocol";
import { ensureHubRunning } from "../src/hub-spawn.ts";
import { runCmd } from "../src/run.ts";
import { runHeadless } from "../src/headless.ts";
import { parseRunArgs } from "../src/parse-run.ts";
import { lsCmd } from "../src/ls.ts";
import { watchCmd } from "../src/watch.ts";
import { parseWatchArgs } from "../src/parse-watch.ts";
import { dashCmd } from "../src/dash.ts";
import { parseDashArgs } from "../src/parse-dash.ts";
import { inspectCmd } from "../src/inspect.ts";
import { explainCmd } from "../src/explain.ts";
import { killCmd } from "../src/kill.ts";
import { attachCmd } from "../src/attach.ts";
import { seenCmd } from "../src/seen.ts";
import { runEmit } from "../src/emit.ts";
import { runAdapterCmd } from "../src/adapter-cmd.ts";
import { runHubCmd } from "../src/hub-cmd.ts";
import { statuslineCmd, cycleShowCmd } from "../src/statusline-cmd.ts";
import { statuslineClick } from "../src/statusline-click.ts";
import { readTmuxStyle } from "../src/statusline-style.ts";
import { staleMarker } from "../src/statusline-cache.ts";
import { runNotifyd, postIngest } from "../src/notifyd.ts";
import { execFile } from "node:child_process";
import { loadAttentionConfigFile, loadAttentionConfig } from "../src/attention-config.ts";
import { discoverHubUrl, resolveLiveHubUrl } from "../src/emit.ts";
import { formatVersion } from "../src/version-cmd.ts";
import { HELP_TEXT } from "../src/usage.ts";
import { createDefaultRegistry } from "@agmux/adapters";
import { decideLaunchMode } from "../src/launch-mode.ts";
import { adapterReadyOrHint } from "../src/adapter-ready.ts";
import { loadProfile, loadLsConfig, loadDashConfig, type LsConfig, type DashConfig, type ProfileConfig } from "@agmux/wrapper";
import { parseLsArgs } from "../src/parse-ls.ts";

const stateDir = path.join(os.homedir(), AGMUX_STATE_DIR_DEFAULT);
const hubBin = process.env.AGMUX_HUB_BIN ?? "agmux-hub";
const wrapBin = process.env.AGMUX_WRAP_BIN ?? "agmux-wrap";

// stdout of a command run without a shell.
function capture(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, (err, stdout) => { if (err) reject(err); else resolve(stdout); });
  });
}

const argv = process.argv.slice(2);
const verb = argv[0];

function usage(): never {
  console.error(HELP_TEXT);
  process.exit(2);
}

async function main(): Promise<number> {
  if (verb === "-v" || verb === "--version" || verb === "version") {
    console.log(formatVersion());
    return 0; // no hub needed
  }
  if (verb === "-h" || verb === "--help" || verb === "help") {
    console.log(HELP_TEXT); // help goes to stdout, exit 0 (vs usage() error → stderr, exit 2)
    return 0;
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

  // `statusline` renders into tmux's status-format expansion; spawning a hub
  // daemon as a side effect of painting a status bar is unacceptable, so it
  // resolves the hub URL passively (env, else the port file) and handles
  // "no hub" as a normal render state — never before the ensureHubRunning gate.
  if (verb === "statusline") {
    const check = argv.includes("--check");
    const printConfig = argv.includes("--print-config");
    const configPath = path.join(os.homedir(), AGMUX_CONFIG_SUBPATH);
    let config;
    try { config = loadAttentionConfigFile(configPath); }
    catch { config = loadAttentionConfig(""); }
    const deps = {
      fetchImpl: fetch, out: (s: string) => console.log(s), config,
      env: process.env,
      readFile: (p: string) => { try { return fs.readFileSync(p, "utf8"); } catch { return null; } },
      tmuxStyle: () => readTmuxStyle(capture),
    };
    // --click <left|right> <token>: agmux.tmux's status-line mouse bindings.
    // Like `seen`, a click with no hub is a quiet no-op, never a hub spawn.
    const clickAt = argv.indexOf("--click");
    if (clickAt >= 0) {
      const button = argv[clickAt + 1];
      const token = argv[clickAt + 2];
      if ((button !== "left" && button !== "right") || !token) usage();
      const clickHub = discoverHubUrl(process.env, stateDir);
      if (!clickHub) return 0;
      const seenDeps = { fetchImpl: fetch, now: () => new Date().toISOString(), newId: () => crypto.randomUUID() };
      return statuslineClick(button, token, {
        attach: (idOrPrefix) => attachCmd({ idOrPrefix, hubUrl: clickHub, wrapBin }),
        seen: (o) => seenCmd({ ...o, hubUrl: clickHub, host: os.hostname() }, seenDeps),
        cycleShow: (step) => cycleShowCmd(step, { hubUrl: clickHub }, deps),
      });
    }
    // --print-config is for agmux.tmux at plugin load: resolved config-file
    // defaults only, no hub involved, must never fail (see statusline-cmd.ts).
    if (printConfig) return statuslineCmd({ hubUrl: "", printConfig: true }, deps);
    // --check reads the daemon's cache file and never needs a hub.
    if (check) return statuslineCmd({ hubUrl: "", check: true }, deps);
    const hubUrl = discoverHubUrl(process.env, stateDir);
    if (!hubUrl) { console.log(staleMarker("hub down")); return 0; }
    return statuslineCmd({ hubUrl }, deps);
  }

  // `seen` runs from tmux's pane-focus-in hook on every pane switch: it must be
  // cheap and must never spawn a hub — no hub means nothing to acknowledge.
  if (verb === "seen") {
    const flag = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
    const pane = flag("--pane");
    const socket = flag("--socket") || undefined;
    const source = flag("--source");
    const all = argv.includes("--all");
    const id = pane || all ? undefined : argv[1];
    if (!pane && !id && !all) usage();
    if (source !== undefined && source !== "dismiss" && source !== "focus") usage();
    const seenHub = discoverHubUrl(process.env, stateDir);
    if (!seenHub) return pane ? 0 : 1;
    return seenCmd(
      { idOrPrefix: id, pane, all, socket, source: source as "dismiss" | "focus" | undefined, hubUrl: seenHub, host: os.hostname() },
      { fetchImpl: fetch, now: () => new Date().toISOString(), newId: () => crypto.randomUUID() },
    );
  }

  // Hub required for every verb. `run` would also accept a still-spawning hub
  // because the wrapper queues to disk; for simplicity here we ensure it for all.
  const hubUrl = await ensureHubRunning(stateDir, hubBin);

  switch (verb) {
    case "notifyd": {
      const configPath = path.join(os.homedir(), AGMUX_CONFIG_SUBPATH);
      let config;
      try { config = loadAttentionConfigFile(configPath); }
      catch { config = loadAttentionConfig(""); }
      return runNotifyd(
        {
          hubUrl,
          // The daemon outlives hub restarts, which move the port — re-resolve.
          resolveHubUrl: () => resolveLiveHubUrl(process.env, stateDir),
          lockPath: path.join(stateDir, "notifyd.lock"),
          replace: argv.includes("--replace"),
        },
        {
          env: process.env, config,
          tmuxStyle: () => readTmuxStyle(capture),
          paneSignals: {
            capture,
            host: os.hostname(),
            newId: () => crypto.randomUUID(),
            post: postIngest,
          },
        },
      );
    }
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
      let kind: "claude" | "codex" | "pi" | undefined;
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
      // back to wrapped (tracked, no config writes). Headless uses neither mode, so
      // the check (and its "launching wrapped" hint) would only be misleading noise.
      if (mode === "direct" && adapter && kind && parsed.placement !== "headless") {
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

      // Resolve --prompt-file to text (parse-run kept the path; IO lives here).
      let prompt: string | undefined = parsed.prompt;
      if (parsed.promptFile) {
        try { prompt = await Bun.file(parsed.promptFile).text(); }
        catch (e) { console.error(`agmux run: cannot read --prompt-file ${parsed.promptFile}: ${e instanceof Error ? e.message : String(e)}`); return 2; }
      }

      // Headless: no tmux, no wrapper, no launch-mode decision — spawn the agent
      // directly, stream its stdout, exit with its code. Needs a concrete profile
      // (inline mode synthesizes one) because the adapter plans off command+args.
      if (parsed.placement === "headless") {
        let profile: ProfileConfig;
        let profileName: string | null;
        if (parsed.kind === "profile") {
          try { profile = loadProfile(parsed.profileName, configPath); }
          catch (e) { console.error(e instanceof Error ? e.message : String(e)); return 2; }
          profileName = parsed.profileName;
        } else {
          profile = {
            agent_kind: parsed.agent_kind, command: parsed.command,
            args: parsed.args, env: {},
          };
          profileName = null;
        }
        const res = await runHeadless({
          profile, profileName, prompt: prompt!, hubUrl, stateDir, registry,
        });
        if (res.error) { console.error(`agmux run: ${res.error}`); return res.exitCode; }
        console.error(`agmux: headless session ${res.sessionId!.slice(0, 8)}`);
        return res.exitCode;
      }

      if (parsed.kind === "profile") {
        return runCmd({
          kind: "profile", profileName: parsed.profileName,
          placement: parsed.placement, detach: parsed.detach, hubUrl, wrapBin, mode,
          agentKind: kind, prompt,
        }, agmuxBin);
      }
      return runCmd({
        kind: "inline", agent_kind: parsed.agent_kind, command: parsed.command, args: parsed.args,
        placement: parsed.placement, detach: parsed.detach, hubUrl, wrapBin, mode,
        agentKind: kind, prompt,
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
    case "watch": {
      const parsed = parseWatchArgs(argv.slice(1));
      if (parsed.kind === "error") { console.error(parsed.message); return 2; }
      // Long-lived view: follow the hub across restarts (see resolveLiveHubUrl).
      return watchCmd({ ...parsed.opts, hubUrl, resolveHubUrl: () => resolveLiveHubUrl(process.env, stateDir) });
    }
    case "dash": {
      const configPath = path.join(os.homedir(), AGMUX_CONFIG_SUBPATH);
      let dashDefaults: DashConfig;
      try { dashDefaults = loadDashConfig(configPath); }
      catch (e) { console.error(e instanceof Error ? e.message : String(e)); return 2; }
      const parsed = parseDashArgs(argv.slice(1), dashDefaults);
      if (parsed.kind === "error") { console.error(parsed.message); return 2; }
      // Long-lived view: follow the hub across restarts (see resolveLiveHubUrl).
      return dashCmd({ ...parsed.opts, hubUrl, wrapBin, resolveHubUrl: () => resolveLiveHubUrl(process.env, stateDir) });
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
    case "explain": {
      const paneIdx = argv.indexOf("--pane");
      const pane = paneIdx >= 0 ? argv[paneIdx + 1] : undefined;
      const id = argv.slice(1).find((a, i, all) => !a.startsWith("--") && all[i - 1] !== "--pane");
      if (!pane && !id) usage();
      return explainCmd(
        { idOrPrefix: id, pane, json: argv.includes("--json"), hubUrl },
        { fetchImpl: fetch, out: (s) => console.log(s), err: (s) => console.error(s) },
      );
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
