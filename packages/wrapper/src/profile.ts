import * as fs from "node:fs";
import * as os from "node:os";
import { parse as parseToml } from "smol-toml";
import { expandStatusFilter, type AgentKind } from "@agmux/protocol";

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
  if (!p) {
    const available = Object.keys(cfg.profiles).sort();
    const listed = available.length > 0 ? available.join(", ") : "(none)";
    throw new Error(`profile not found: ${name}. Available: ${listed}`);
  }
  return p;
}

// Display defaults for `agmux ls` ([ls] section). Precedence is resolved by
// the CLI: flag > config > built-in default.
export interface LsConfig {
  limit?: number;
  sort?: "started" | "activity";
  asc?: boolean;
  reverse?: boolean;
  status?: string; // group alias or comma-separated statuses (pre-validated)
}

export function parseLsSection(raw: unknown): LsConfig {
  if (raw === undefined) return {};
  if (typeof raw !== "object" || raw === null) throw new Error("[ls] must be a table");
  const r = raw as Record<string, unknown>;
  const out: LsConfig = {};
  if (r.limit !== undefined) {
    if (typeof r.limit !== "number" || !Number.isInteger(r.limit) || r.limit < 1)
      throw new Error(`[ls] limit must be a positive integer, got ${JSON.stringify(r.limit)}`);
    out.limit = r.limit;
  }
  if (r.sort !== undefined) {
    if (r.sort !== "started" && r.sort !== "activity")
      throw new Error(`[ls] sort must be 'started' or 'activity', got ${JSON.stringify(r.sort)}`);
    out.sort = r.sort;
  }
  if (r.asc !== undefined) {
    if (typeof r.asc !== "boolean") throw new Error(`[ls] asc must be a boolean, got ${JSON.stringify(r.asc)}`);
    out.asc = r.asc;
  }
  if (r.reverse !== undefined) {
    if (typeof r.reverse !== "boolean") throw new Error(`[ls] reverse must be a boolean, got ${JSON.stringify(r.reverse)}`);
    out.reverse = r.reverse;
  }
  if (r.status !== undefined) {
    if (typeof r.status !== "string" || expandStatusFilter(r.status) === null)
      throw new Error(`[ls] status must be active|open|closed or comma-separated statuses, got ${JSON.stringify(r.status)}`);
    out.status = r.status;
  }
  return out;
}

// Parses ONLY the [ls] table so a broken [profiles.*] entry can't break `ls`.
// Missing file or section → {} (built-in defaults). Invalid values throw.
export function loadLsConfig(configPath: string): LsConfig {
  if (!fs.existsSync(configPath)) return {};
  const raw = parseToml(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
  return parseLsSection(raw.ls);
}
