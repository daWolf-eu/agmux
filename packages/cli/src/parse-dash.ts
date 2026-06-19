import type { DashConfig, LsConfig } from "@agmux/wrapper";
import type { PreviewMode } from "@agmux/tui";
import { parseLsArgs, type LsQueryOpts } from "./parse-ls.ts";

export interface DashOpts extends LsQueryOpts {
  intervalMs: number;
  preview: PreviewMode;
  popup: boolean;
}

export type ParsedDash =
  | { kind: "ok"; opts: DashOpts }
  | { kind: "error"; message: string };

function isPreview(v: string): v is PreviewMode {
  return v === "mirror" || v === "events" || v === "detail";
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
        return { kind: "error", message: "dash: --preview must be 'mirror', 'events' or 'detail'" };
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

  return {
    kind: "ok",
    opts: {
      ...parsed.opts,
      intervalMs: Math.round((intervalSec ?? cfg.interval ?? 1) * 1000),
      preview: preview ?? cfg.preview ?? "mirror",
      popup,
    },
  };
}
