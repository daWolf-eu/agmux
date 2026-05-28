import * as fs from "node:fs";
import * as os from "node:os";
import { parse as parseToml } from "smol-toml";
import type { AgentKind } from "@agmux/protocol";

export interface ProfileConfig {
  agent_kind: AgentKind;
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  resume_template?: string; // reserved; ignored in MVP
}

export interface AgmuxConfig {
  profiles: Record<string, ProfileConfig>;
}

function asAgentKind(v: unknown): AgentKind {
  if (v === "claude" || v === "codex") return v;
  throw new Error(`profile: agent_kind must be 'claude' or 'codex', got ${JSON.stringify(v)}`);
}

// POSIX-shell-style prefix tilde expansion: leading `~` or `~/` → $HOME.
// Embedded `~` is left alone (matches shell semantics; only quoting-bare prefix expands).
export function expandTilde(s: string): string {
  if (s === "~") return os.homedir();
  if (s.startsWith("~/")) return os.homedir() + s.slice(1);
  return s;
}

export function parseConfig(toml: string): AgmuxConfig {
  const raw = parseToml(toml) as any;
  const profiles: Record<string, ProfileConfig> = {};
  const src = (raw.profiles ?? {}) as Record<string, any>;
  for (const [name, p] of Object.entries(src)) {
    profiles[name] = {
      agent_kind: asAgentKind(p.agent_kind),
      command: expandTilde(String(p.command)),
      args: Array.isArray(p.args) ? p.args.map(String) : [],
      env: typeof p.env === "object" && p.env !== null
        ? Object.fromEntries(Object.entries(p.env).map(([k, v]) => [k, expandTilde(String(v))]))
        : {},
      cwd: typeof p.cwd === "string" ? expandTilde(p.cwd) : undefined,
      resume_template: typeof p.resume_template === "string" ? p.resume_template : undefined,
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
