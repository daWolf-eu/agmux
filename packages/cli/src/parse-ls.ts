import { expandStatusFilter } from "@agmux/protocol";
import type { LsConfig } from "@agmux/wrapper";

// Fully resolved ls options (flag > config > built-in default).
export interface LsQueryOpts {
  limit: number;
  sort: "started" | "activity";
  asc: boolean;
  reverse: boolean;   // display-only: flip rows top↔bottom after sort+limit
  status?: string;    // group alias or comma list, validated; undefined = all
  agent?: string;
  profile?: string;
}

export type ParsedLs =
  | { kind: "ok"; opts: LsQueryOpts }
  | { kind: "error"; message: string };

const DEFAULT_LIMIT = 50;
const ALL_LIMIT = 10000;

export function parseLsArgs(argv: string[], defaults: LsConfig): ParsedLs {
  let limit: number | undefined;
  let all = false;
  let sort: "started" | "activity" | undefined;
  let asc: boolean | undefined;
  let reverse: boolean | undefined;
  let status: string | undefined;
  let live = false;
  let agent: string | undefined;
  let profile: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const eq = a.indexOf("=");
    const name = eq >= 0 ? a.slice(0, eq) : a;
    // value flags accept both `--flag value` and `--flag=value`
    const take = (): string | undefined => (eq >= 0 ? a.slice(eq + 1) : argv[++i]);
    // boolean flags take no value; reject an attached `=...`
    const bool = (): ParsedLs | null =>
      eq >= 0 ? { kind: "error", message: `ls: ${name} does not take a value` } : null;
    switch (name) {
      case "-n": case "--limit": {
        const v = take();
        const num = v === undefined ? NaN : Number(v);
        if (!Number.isInteger(num) || num < 1)
          return { kind: "error", message: `ls: ${name} requires a positive integer` };
        limit = num; break;
      }
      case "--all": { const e = bool(); if (e) return e; all = true; break; }
      case "--sort": {
        const v = take();
        if (v !== "started" && v !== "activity")
          return { kind: "error", message: "ls: --sort must be 'started' or 'activity'" };
        sort = v; break;
      }
      case "--asc": { const e = bool(); if (e) return e; asc = true; break; }
      case "--desc": { const e = bool(); if (e) return e; asc = false; break; }
      case "-r": case "--reverse": { const e = bool(); if (e) return e; reverse = true; break; }
      case "--no-reverse": { const e = bool(); if (e) return e; reverse = false; break; }
      case "--status": {
        const v = take();
        if (!v || expandStatusFilter(v) === null)
          return { kind: "error", message: "ls: --status must be active|open|closed or comma-separated statuses (idle,running,waiting,ended,lost)" };
        status = v; break;
      }
      case "--live": { const e = bool(); if (e) return e; live = true; break; }
      case "--agent": {
        const v = take();
        if (!v) return { kind: "error", message: "ls: --agent requires a value" };
        agent = v; break;
      }
      case "--profile": {
        const v = take();
        if (!v) return { kind: "error", message: "ls: --profile requires a value" };
        profile = v; break;
      }
      default:
        return { kind: "error", message: `ls: unknown flag ${a}` };
    }
  }

  return {
    kind: "ok",
    opts: {
      limit: limit ?? (all ? ALL_LIMIT : defaults.limit ?? DEFAULT_LIMIT),
      sort: sort ?? defaults.sort ?? "started",
      asc: asc ?? defaults.asc ?? false,
      reverse: reverse ?? defaults.reverse ?? false,
      status: status ?? (live ? "open" : defaults.status),
      agent,
      profile,
    },
  };
}
