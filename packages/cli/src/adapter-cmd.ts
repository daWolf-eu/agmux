import * as fs from "node:fs";
import type { AgentKind } from "@agmux/protocol";
import {
  installAdapter, uninstallAdapter, loadRecord,
  type Registry, type InstallContext,
} from "@agmux/adapters";
import { parseConfig, expandTilde, type AgmuxConfig } from "@agmux/wrapper";

export interface AdapterCmdDeps {
  registry: Registry;
  stateDir: string;
  configPath: string;
  agmuxEmitPath: string;
  out: (line: string) => void;
}

interface Target { agentKind: AgentKind; profile: string | null; profileEnv: Record<string, string>; }

function readConfig(configPath: string): AgmuxConfig {
  if (!fs.existsSync(configPath)) return { profiles: {} };
  return parseConfig(fs.readFileSync(configPath, "utf8"));
}

// Resolve a CLI target. `["work"]` => profile "work"; `["--kind","claude"]` => bare kind.
function resolveTarget(args: string[], cfg: AgmuxConfig): Target | { error: string } {
  const kindIdx = args.indexOf("--kind");
  if (kindIdx >= 0) {
    const k = args[kindIdx + 1];
    if (k !== "claude" && k !== "codex" && k !== "pi") return { error: `--kind must be 'claude', 'codex', or 'pi'` };
    return { agentKind: k, profile: null, profileEnv: {} };
  }
  const profile = args.find((a) => !a.startsWith("-"));
  if (!profile) return { error: "expected a <profile> name or --kind <agent_kind>" };
  const p = cfg.profiles[profile];
  if (!p) return { error: `profile not found: ${profile}` };
  return { agentKind: p.agent_kind, profile, profileEnv: p.env };
}

function ctxFor(t: Target, deps: AdapterCmdDeps, configDirOverride: string | null): InstallContext {
  return {
    agentKind: t.agentKind, profile: t.profile, profileEnv: t.profileEnv,
    agmuxEmitPath: deps.agmuxEmitPath, stateDir: deps.stateDir,
    configDirOverride,
  };
}

// Extract `--config-dir <path>` and return the remaining args; the value must be
// stripped before target resolution or it would be mistaken for a profile name.
function takeConfigDir(args: string[]): { rest: string[]; configDir: string | null } {
  const i = args.indexOf("--config-dir");
  if (i < 0) return { rest: args, configDir: null };
  const v = args[i + 1] ?? null;
  return { rest: [...args.slice(0, i), ...args.slice(i + 2)], configDir: v ? expandTilde(v) : null };
}

function label(t: { agentKind: AgentKind; profile: string | null }): string {
  return t.profile ? `${t.agentKind}@${t.profile}` : `${t.agentKind} (bare)`;
}

export async function runAdapterCmd(args: string[], deps: AdapterCmdDeps): Promise<number> {
  const sub = args[0];
  const rest = args.slice(1);
  const cfg = readConfig(deps.configPath);

  if (sub === "list") {
    const kinds = deps.registry.kinds();
    if (kinds.length === 0) {
      deps.out("no adapters registered (per-provider modules land in packages/adapters/src/adapters/index.ts)");
      return 0;
    }
    for (const kind of kinds) {
      const bare = loadRecord(deps.stateDir, kind, null);
      deps.out(`${kind} (bare): ${bare ? `installed (v${bare.adapterVersion})` : "not installed"}`);
      for (const [name, p] of Object.entries(cfg.profiles)) {
        if (p.agent_kind !== kind) continue;
        const rec = loadRecord(deps.stateDir, kind, name);
        deps.out(`${kind}@${name}: ${rec ? `installed (v${rec.adapterVersion})` : "not installed"}`);
      }
    }
    return 0;
  }

  if (sub === "install" || sub === "uninstall" || sub === "status") {
    const { rest: targetArgs, configDir } = takeConfigDir(rest);
    const t = resolveTarget(targetArgs, cfg);
    if ("error" in t) { deps.out(t.error); return 2; }
    const adapter = deps.registry.lookup(t.agentKind);
    if (!adapter) { deps.out(`no adapter registered for kind '${t.agentKind}'`); return 1; }
    const ctx = ctxFor(t, deps, configDir);

    if (sub === "install") {
      const rec = installAdapter(adapter, ctx);
      deps.out(`installed ${label(t)} (v${rec.adapterVersion})`);
      return 0;
    }
    if (sub === "uninstall") {
      const ok = uninstallAdapter(adapter, ctx);
      deps.out(ok ? `uninstalled ${label(t)}` : `${label(t)} was not installed`);
      return 0;
    }
    // status
    const st = adapter.status(ctx);
    deps.out(`${label(t)}: ${st.installed ? `installed (v${st.version})` : "not installed"}${st.drift ? " [drift]" : ""}`);
    return 0;
  }

  deps.out("usage: agmux adapter list|install|status|uninstall (<profile> | --kind <agent_kind>) [--config-dir <path>]");
  return 2;
}
