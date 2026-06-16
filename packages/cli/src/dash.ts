import { runManage, type RunManageOpts, type PreviewSource, type Actions } from "@agmux/tui";
import { buildLsQuery } from "./ls.ts";
import { makePreviewSource } from "./dash-preview.ts";
import { makeActions } from "./dash-actions.ts";
import type { DashOpts } from "./parse-dash.ts";

export interface DashCmdDeps {
  isTTY: () => boolean;
  runManageImpl: (o: RunManageOpts) => Promise<number>;
  makeSourceImpl: (hubUrl: string) => PreviewSource;
  makeActionsImpl: (hubUrl: string, wrapBin: string) => Actions;
  errOut: (s: string) => void;
}

const defaultDeps: DashCmdDeps = {
  isTTY: () => Boolean(process.stdout.isTTY && process.stdin.isTTY),
  runManageImpl: runManage,
  makeSourceImpl: makePreviewSource,
  makeActionsImpl: makeActions,
  errOut: (s) => console.error(s),
};

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
    query: buildLsQuery(opts),
    intervalMs: opts.intervalMs,
    defaultPreview: opts.preview,
    source: deps.makeSourceImpl(opts.hubUrl),
    actions: deps.makeActionsImpl(opts.hubUrl, opts.wrapBin),
  });
}
