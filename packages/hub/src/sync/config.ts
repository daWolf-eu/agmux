import fs from "node:fs";
import { parse as parseToml } from "smol-toml";

export interface RemoteConfig {
  name: string; transport: "openshell"; gateway: string; selector: string;
  interval: number; openshell_bin: string; agmux_bin: string;
}

const NAME_RE = /^[A-Za-z0-9._-]+$/;
const KEYS = new Set(["name", "transport", "gateway", "selector", "interval", "openshell_bin", "agmux_bin"]);

function str(t: Record<string, unknown>, key: string, def: string | undefined, fail: (m: string) => never): string {
  const v = t[key];
  if (v === undefined) {
    if (def === undefined) return fail(`missing ${key}`);
    return def;
  }
  if (typeof v !== "string" || v === "") return fail(`${key} must be a non-empty string`);
  return v;
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
  if (typeof interval !== "number" || !Number.isFinite(interval) || interval <= 0) return fail("interval must be a positive number");
  return {
    name, transport, gateway, interval,
    selector: str(tbl, "selector", "agmux=1", fail),
    openshell_bin: str(tbl, "openshell_bin", "openshell", fail),
    agmux_bin: str(tbl, "agmux_bin", "agmux", fail),
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
  const root = parseToml(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
  return parseRemotes(root.remote);
}
