import * as fs from "node:fs";
import { parse as parseToml } from "smol-toml";
import type { AgentKind } from "@agmux/protocol";

export interface ProfileConfig {
  agent_kind: AgentKind;
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  resume_template?: string; // reserved; ignored in MVP
  // When true (default), spawn via `$SHELL -ic 'exec <command> <args...>'` so user
  // shell aliases resolve. Opt out for compound aliases or raw-binary requirements.
  use_shell?: boolean;
}

export interface AgmuxConfig {
  profiles: Record<string, ProfileConfig>;
}

function asAgentKind(v: unknown): AgentKind {
  if (v === "claude" || v === "codex") return v;
  throw new Error(`profile: agent_kind must be 'claude' or 'codex', got ${JSON.stringify(v)}`);
}

export function parseConfig(toml: string): AgmuxConfig {
  const raw = parseToml(toml) as any;
  const profiles: Record<string, ProfileConfig> = {};
  const src = (raw.profiles ?? {}) as Record<string, any>;
  for (const [name, p] of Object.entries(src)) {
    profiles[name] = {
      agent_kind: asAgentKind(p.agent_kind),
      command: String(p.command),
      args: Array.isArray(p.args) ? p.args.map(String) : [],
      env: typeof p.env === "object" && p.env !== null
        ? Object.fromEntries(Object.entries(p.env).map(([k, v]) => [k, String(v)]))
        : {},
      cwd: typeof p.cwd === "string" ? p.cwd : undefined,
      resume_template: typeof p.resume_template === "string" ? p.resume_template : undefined,
      use_shell: typeof p.use_shell === "boolean" ? p.use_shell : undefined,
    };
  }
  return { profiles };
}

export function loadProfile(name: string, configPath: string): ProfileConfig {
  if (!fs.existsSync(configPath)) {
    throw new Error(`agmux config not found at ${configPath}`);
  }
  const cfg = parseConfig(fs.readFileSync(configPath, "utf8"));
  const p = cfg.profiles[name];
  if (!p) throw new Error(`profile not found: ${name}`);
  return p;
}
