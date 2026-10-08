import { DASH_GROUP_KEYS, type DashConfig, type DashGroupKey, type LsConfig } from "@agmux/wrapper";
import { COLUMN_KEYS, DEFAULT_COLUMNS, isColumnKey, type ColumnKey, type PreviewMode } from "@agmux/tui";
import { parseLsArgs, type LsQueryOpts } from "./parse-ls.ts";

// Resolved poll settings for one activity group.
export interface DashGroupOpts {
  limit: number;
  intervalMs: number;
}

// Built-in per-group defaults. `open` is what you stare at, so it stays cheap
// enough to poll every second; the terminal-heavy groups trade freshness for
// reach (closed sessions don't change once they're closed).
const GROUP_DEFAULTS: Record<DashGroupKey, DashGroupOpts> = {
  open: { limit: 50, intervalMs: 1_000 },
  closed: { limit: 1_000, intervalMs: 10_000 },
  all: { limit: 1_000, intervalMs: 10_000 },
};

export interface DashOpts extends LsQueryOpts {
  intervalMs: number;  // preview refresh cadence (and the `open` group's floor)
  preview: PreviewMode;
  popup: boolean;
  groups: Record<DashGroupKey, DashGroupOpts>;
  columns: ColumnKey[];
  header: boolean;
}

export type ParsedDash =
  | { kind: "ok"; opts: DashOpts }
  | { kind: "error"; message: string };

function isPreview(v: string): v is PreviewMode {
  return v === "mirror" || v === "detail";
}

// flag (applies to every group) > [dash.<group>] > [dash] > built-in default.
function resolveGroups(
  cfg: DashConfig,
  flagLimit: number | undefined,
  flagIntervalSec: number | undefined,
): Record<DashGroupKey, DashGroupOpts> {
  const out = {} as Record<DashGroupKey, DashGroupOpts>;
  for (const g of DASH_GROUP_KEYS) {
    const per = cfg.groups?.[g];
    const limit = flagLimit ?? per?.limit ?? cfg.limit ?? GROUP_DEFAULTS[g].limit;
    const intervalSec = flagIntervalSec ?? per?.interval ?? cfg.interval;
    out[g] = {
      limit,
      intervalMs: intervalSec === undefined ? GROUP_DEFAULTS[g].intervalMs : Math.round(intervalSec * 1000),
    };
  }
  return out;
}

function resolveColumns(cfg: DashConfig): { ok: true; columns: ColumnKey[] } | { ok: false; message: string } {
  if (!cfg.columns) return { ok: true, columns: [...DEFAULT_COLUMNS] };
  const unknown = cfg.columns.filter((c) => !isColumnKey(c));
  if (unknown.length > 0)
    return { ok: false, message: `dash: unknown [dash] columns ${unknown.map((c) => JSON.stringify(c)).join(", ")} (known: ${COLUMN_KEYS.join(", ")})` };
  const dup = cfg.columns.find((c, i) => cfg.columns!.indexOf(c) !== i);
  if (dup) return { ok: false, message: `dash: duplicate [dash] column ${JSON.stringify(dup)}` };
  return { ok: true, columns: cfg.columns as ColumnKey[] };
}

export function parseDashArgs(argv: string[], cfg: DashConfig): ParsedDash {
  const rest: string[] = [];
  let intervalSec: number | undefined;
  let preview: PreviewMode | undefined;
  let popup = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const eq = a.indexOf("=");
    const name = eq >= 0 ? a.slice(0, eq) : a;
    if (name === "-i" || name === "--interval") {
      const v = eq >= 0 ? a.slice(eq + 1) : argv[++i];
      const num = v === undefined ? NaN : Number(v);
      if (!Number.isFinite(num) || num <= 0)
        return { kind: "error", message: `dash: ${name} requires a positive number of seconds` };
      intervalSec = num;
    } else if (name === "--preview") {
      const v = eq >= 0 ? a.slice(eq + 1) : argv[++i];
      if (!v || !isPreview(v))
        return { kind: "error", message: "dash: --preview must be 'mirror' or 'detail'" };
      preview = v;
    } else if (name === "--popup") {
      popup = true;
    } else {
      rest.push(a);
    }
  }

  // ls defaults: dash mirrors watch (status=open, sort=started) unless config overrides.
  const lsDefaults: LsConfig = { status: cfg.status ?? "open", sort: cfg.sort ?? "started" };
  const parsed = parseLsArgs(rest, lsDefaults);
  if (parsed.kind === "error")
    return { kind: "error", message: parsed.message.replace(/^ls:/, "dash:") };

  const cols = resolveColumns(cfg);
  if (!cols.ok) return { kind: "error", message: cols.message };

  const groups = resolveGroups(cfg, parsed.explicit.limit ? parsed.opts.limit : undefined, intervalSec);

  return {
    kind: "ok",
    opts: {
      ...parsed.opts,
      // `limit` on the shared ls opts is unused by the dash (each group carries
      // its own); keep it in sync with the fast group so it never misleads.
      limit: groups.open.limit,
      groups,
      intervalMs: Math.round((intervalSec ?? cfg.interval ?? 1) * 1000),
      preview: preview ?? cfg.preview ?? "mirror",
      popup,
      columns: cols.columns,
      header: cfg.header ?? false,
    },
  };
}
