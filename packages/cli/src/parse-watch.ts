import type { LsConfig } from "@agmux/wrapper";
import { parseLsArgs, type LsQueryOpts } from "./parse-ls.ts";

export interface WatchOpts extends LsQueryOpts {
  intervalMs: number;
}

export type ParsedWatch =
  | { kind: "ok"; opts: WatchOpts }
  | { kind: "error"; message: string };

// watch deliberately ignores [ls] config defaults. Built-ins: status=open
// (closed sessions don't change), sort=started (stable ordering — rows must
// not jump around mid-watch while sessions have no human-readable label).
const WATCH_DEFAULTS: LsConfig = { status: "open", sort: "started" };

export function parseWatchArgs(argv: string[]): ParsedWatch {
  const rest: string[] = [];
  let intervalSec: number | undefined;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const eq = a.indexOf("=");
    const name = eq >= 0 ? a.slice(0, eq) : a;
    if (name === "-i" || name === "--interval") {
      const v = eq >= 0 ? a.slice(eq + 1) : argv[++i];
      const num = v === undefined ? NaN : Number(v);
      if (!Number.isFinite(num) || num <= 0)
        return { kind: "error", message: `watch: ${name} requires a positive number of seconds` };
      intervalSec = num;
    } else {
      rest.push(a);
    }
  }

  const parsed = parseLsArgs(rest, WATCH_DEFAULTS);
  if (parsed.kind === "error")
    return { kind: "error", message: parsed.message.replace(/^ls:/, "watch:") };
  return { kind: "ok", opts: { ...parsed.opts, intervalMs: Math.round((intervalSec ?? 1) * 1000) } };
}
