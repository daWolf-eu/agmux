import type { Registry } from "@agmux/adapters";
import type { AgentKind } from "@agmux/protocol";
import type { ParsedRun } from "./parse-run.ts";
import { adapterReadyOrHint, launchEnv } from "./adapter-ready.ts";

// A session that can self-register (has an adapter) runs directly; everything
// else (or an explicit --wrapped) goes through the PTY wrapper.
export type LaunchMode = "direct" | "wrapped";

export function decideLaunchMode(o: { wrapped: boolean; hasAdapter: boolean }): LaunchMode {
  if (o.wrapped) return "wrapped";      // explicit opt-in
  if (!o.hasAdapter) return "wrapped";  // can't self-register → must wrap
  return "direct";
}

export type LocalRun = Extract<ParsedRun, { kind: "profile" | "inline" }>;

export interface LaunchPlanDeps {
  registry: Registry;
  env: Record<string, string | undefined>;  // the process env (adapter config-dir keys)
  loadProfile: (name: string) => { agent_kind: AgentKind; env: Record<string, string> };
  agmuxEmitPath: string;
  stateDir: string;
  err: (line: string) => void;
}

// mode + the env a direct agent runs with (the env its adapter was checked
// against), or the exit code when --direct cannot launch direct.
export type LaunchPlan = { mode: LaunchMode; kind: AgentKind | undefined; agentEnv: Record<string, string> } | { exitCode: number };

// Resolve the agent kind + profile env to decide direct-vs-wrapped. Inline mode
// names its kind directly; profile mode reads it from the profile config. A
// profile that fails to load leaves kind undefined so we fall back to wrapped;
// the wrapper surfaces the real profile error.
export function planLaunch(parsed: LocalRun, deps: LaunchPlanDeps): LaunchPlan {
  let kind: AgentKind | undefined;
  let profileEnv: Record<string, string> = {};
  if (parsed.kind === "inline") {
    kind = parsed.agent_kind;
  } else {
    try { const p = deps.loadProfile(parsed.profileName); kind = p.agent_kind; profileEnv = p.env; }
    catch { kind = undefined; }
  }

  const adapter = kind ? deps.registry.lookup(kind) : undefined;
  let mode = decideLaunchMode({ wrapped: parsed.wrapped, hasAdapter: !!adapter });
  if (parsed.direct) {
    if (!adapter) { deps.err("agmux run --direct: no adapter for this agent; cannot launch direct"); return { exitCode: 2 }; }
    mode = "direct";
  }
  // Checked and launched with the same env: a CLAUDE_CONFIG_DIR in the process
  // env (e.g. a sandbox exec) counts; a profile's own env wins over it.
  const agentEnv = adapter ? launchEnv(adapter, deps.env, profileEnv) : profileEnv;

  // Direct exec needs the plugin present; we NEVER install without consent.
  // Not ready → the hint, then wrapped (tracked, no config writes); --direct
  // never falls back. Headless uses neither mode, so the check is skipped.
  if (mode === "direct" && adapter && kind && parsed.placement !== "headless") {
    const ready = adapterReadyOrHint(adapter, {
      agentKind: kind,
      profile: parsed.kind === "profile" ? parsed.profileName : null,
      profileEnv: agentEnv,
      agmuxEmitPath: deps.agmuxEmitPath,
      stateDir: deps.stateDir,
      configDirOverride: null,
    }, kind, deps.err, parsed.direct);
    if (!ready) {
      if (parsed.direct) return { exitCode: 2 };
      mode = "wrapped";
    }
  }
  return { mode, kind, agentEnv };
}
