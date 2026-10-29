import fs from "node:fs";
import { parse as parseToml } from "smol-toml";
import { AGENT_KINDS, type AgentKind } from "@agmux/protocol";

// How agmux starts an agent in the sandbox. All-null/empty never occurs: parseLaunch returns null instead.
export interface RemoteLaunch {
  kind: AgentKind | null; profile: string | null; command: string | null; args: string[];
}

export interface RemoteConfig {
  name: string; transport: "openshell"; gateway: string; selector: string;
  interval: number; openshell_bin: string; agmux_bin: string;
  workdir: string | null; launch: RemoteLaunch | null;
}

const NAME_RE = /^[A-Za-z0-9._-]+$/;
// Discovery period and backoff base: below this, `sandbox list` would run in a hot loop.
export const MIN_INTERVAL_S = 0.1;
const KEYS = new Set(["name", "transport", "gateway", "selector", "interval", "openshell_bin", "agmux_bin",
  "workdir", "kind", "profile", "command", "args"]);

function str(t: Record<string, unknown>, key: string, def: string | undefined, fail: (m: string) => never): string {
  const v = t[key];
  if (v === undefined) {
    if (def === undefined) return fail(`missing ${key}`);
    return def;
  }
  if (typeof v !== "string" || v === "") return fail(`${key} must be a non-empty string`);
  return v;
}

function optStr(t: Record<string, unknown>, key: string, fail: (m: string) => never): string | null {
  return t[key] === undefined ? null : str(t, key, undefined, fail);
}

function parseLaunch(t: Record<string, unknown>, fail: (m: string) => never): RemoteLaunch | null {
  const kind = optStr(t, "kind", fail);
  if (kind !== null && !(AGENT_KINDS as readonly string[]).includes(kind)) {
    return fail(`kind must be one of ${AGENT_KINDS.join(", ")}`);
  }
  const profile = optStr(t, "profile", fail);
  const command = optStr(t, "command", fail);
  const rawArgs = t.args;
  if (rawArgs !== undefined && (!Array.isArray(rawArgs) || rawArgs.some((a) => typeof a !== "string"))) {
    return fail("args must be an array of strings");
  }
  const args = (rawArgs as string[] | undefined) ?? [];
  if (kind === null && profile === null && command === null && rawArgs === undefined) return null;
  if (profile !== null && (command !== null || rawArgs !== undefined)) return fail("profile excludes command/args");
  if (profile === null && kind === null) return fail("kind is required unless profile is set");
  return { kind: kind as AgentKind | null, profile, command, args };
}

function parseOne(t: unknown, i: number, seen: Set<string>): RemoteConfig {
  let label = `[[remote]] #${i}`;
  const fail = (m: string): never => { throw new Error(`${label}: ${m}`); };
  if (typeof t !== "object" || t === null || Array.isArray(t)) return fail("must be a table");
  const tbl = t as Record<string, unknown>;
  const name = str(tbl, "name", undefined, fail);
  label = `[[remote]] "${name}"`;
  if (!NAME_RE.test(name)) return fail("invalid name (allowed: A-Z a-z 0-9 . _ -)");
  if (seen.has(name)) return fail("duplicate name");
  seen.add(name);
  for (const k of Object.keys(tbl)) if (!KEYS.has(k)) return fail(`unknown key "${k}"`);
  const transport = str(tbl, "transport", "openshell", fail);
  if (transport !== "openshell") return fail(`transport "${transport}" is not supported yet`);
  const gateway = str(tbl, "gateway", undefined, fail);
  if (!NAME_RE.test(gateway)) return fail("invalid gateway (allowed: A-Z a-z 0-9 . _ -)");
  const interval = tbl.interval ?? 5;
  if (typeof interval !== "number" || !Number.isFinite(interval) || interval < MIN_INTERVAL_S) {
    return fail(`interval must be a number >= ${MIN_INTERVAL_S}`);
  }
  return {
    name, transport, gateway, interval,
    selector: str(tbl, "selector", "agmux=1", fail),
    openshell_bin: str(tbl, "openshell_bin", "openshell", fail),
    agmux_bin: str(tbl, "agmux_bin", "agmux", fail),
    workdir: optStr(tbl, "workdir", fail),
    launch: parseLaunch(tbl, fail),
  };
}

// raw = the TOML root's `remote` value.
export function parseRemotes(raw: unknown): RemoteConfig[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error("[[remote]] must be an array of tables");
  const seen = new Set<string>();
  return raw.map((t, i) => parseOne(t, i, seen));
}

// Parses ONLY the `remote` key so a broken [profiles.*] entry can't break the hub.
// Missing file or section → [].
export function loadRemotes(configPath: string): RemoteConfig[] {
  if (!fs.existsSync(configPath)) return [];
  let root: Record<string, unknown>;
  try {
    root = parseToml(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
  } catch (e) {
    throw new Error(`${configPath}: ${e instanceof Error ? e.message : String(e)}`);
  }
  return parseRemotes(root.remote);
}
