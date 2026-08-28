import {
  runManage, type RunManageOpts, type PreviewSource, type Actions, type GroupQuery,
  type ActivityGroup, GROUPS, initialGroup,
} from "@agmux/tui";
import { buildLsQuery } from "./ls.ts";
import { makePreviewSource } from "./dash-preview.ts";
import { makeActions } from "./dash-actions.ts";
import type { DashOpts } from "./parse-dash.ts";

export interface DashCmdDeps {
  isTTY: () => boolean;
  runManageImpl: (o: RunManageOpts) => Promise<number>;
  makeSourceImpl: (hubUrl: string) => PreviewSource;
  makeActionsImpl: (hubUrl: string, wrapBin: string, popup: boolean) => Actions;
  errOut: (s: string) => void;
}

const defaultDeps: DashCmdDeps = {
  isTTY: () => Boolean(process.stdout.isTTY && process.stdin.isTTY),
  runManageImpl: runManage,
  makeSourceImpl: makePreviewSource,
  makeActionsImpl: makeActions,
  errOut: (s) => console.error(s),
};

// Each activity group filters server-side, so a group's row cap is spent only on
// rows that group can show. "all" takes no status param (the hub returns every
// status).
function statusFor(g: ActivityGroup): string | undefined {
  return g === "all" ? undefined : g;
}

function buildGroupQueries(opts: DashOpts): Record<ActivityGroup, GroupQuery> {
  const out = {} as Record<ActivityGroup, GroupQuery>;
  for (const g of GROUPS) {
    out[g] = {
      query: buildLsQuery({ ...opts, status: statusFor(g), limit: opts.groups[g].limit }),
      intervalMs: opts.groups[g].intervalMs,
    };
  }
  return out;
}

export async function dashCmd(
  opts: DashOpts & { hubUrl: string; wrapBin: string },
  deps: DashCmdDeps = defaultDeps,
): Promise<number> {
  if (!deps.isTTY()) {
    deps.errOut("dash: requires a TTY (use `agmux ls` for scripted output)");
    return 2;
  }
  return deps.runManageImpl({
    hubUrl: opts.hubUrl,
    // One query per activity group (key `f`), each with its own limit and
    // cadence; switching groups switches feeds. `--status`/config only seeds the
    // initial group.
    groupQueries: buildGroupQueries(opts),
    intervalMs: opts.intervalMs,
    defaultPreview: opts.preview,
    initialGroup: initialGroup(opts.status),
    source: deps.makeSourceImpl(opts.hubUrl),
    actions: deps.makeActionsImpl(opts.hubUrl, opts.wrapBin, opts.popup),
  });
}
