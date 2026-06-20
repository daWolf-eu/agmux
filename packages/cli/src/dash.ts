import { runManage, runManageOtui, type RunManageOpts, type PreviewSource, type Actions } from "@agmux/tui";
import { buildLsQuery } from "./ls.ts";
import { makePreviewSource } from "./dash-preview.ts";
import { makeActions } from "./dash-actions.ts";
import type { DashOpts } from "./parse-dash.ts";

export interface DashCmdDeps {
  isTTY: () => boolean;
  runManageImpl: (o: RunManageOpts) => Promise<number>;
  runManageOtuiImpl: (o: RunManageOpts) => Promise<number>;
  tuiKind: () => string | undefined;
  makeSourceImpl: (hubUrl: string) => PreviewSource;
  makeActionsImpl: (hubUrl: string, wrapBin: string, popup: boolean) => Actions;
  errOut: (s: string) => void;
}

const defaultDeps: DashCmdDeps = {
  isTTY: () => Boolean(process.stdout.isTTY && process.stdin.isTTY),
  runManageImpl: runManage,
  runManageOtuiImpl: runManageOtui,
  tuiKind: () => process.env.AGMUX_TUI,
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
  const run = deps.tuiKind() === "opentui" ? deps.runManageOtuiImpl : deps.runManageImpl;
  return run({
    hubUrl: opts.hubUrl,
    query: buildLsQuery(opts),
    intervalMs: opts.intervalMs,
    defaultPreview: opts.preview,
    source: deps.makeSourceImpl(opts.hubUrl),
    actions: deps.makeActionsImpl(opts.hubUrl, opts.wrapBin, opts.popup),
  });
}
