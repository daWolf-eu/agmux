import { runWatch, type RunWatchOpts } from "@agmux/tui";
import { buildLsQuery } from "./ls.ts";
import type { WatchOpts } from "./parse-watch.ts";

export interface WatchCmdDeps {
  isTTY: () => boolean;
  runWatchImpl: (o: RunWatchOpts) => Promise<number>;
  errOut: (s: string) => void;
}

const defaultDeps: WatchCmdDeps = {
  isTTY: () => Boolean(process.stdout.isTTY && process.stdin.isTTY),
  runWatchImpl: runWatch,
  errOut: (s) => console.error(s),
};

export async function watchCmd(
  opts: WatchOpts & { hubUrl: string },
  deps: WatchCmdDeps = defaultDeps,
): Promise<number> {
  if (!deps.isTTY()) {
    deps.errOut("watch: requires a TTY (use `agmux ls` for scripted output)");
    return 2;
  }
  return deps.runWatchImpl({
    hubUrl: opts.hubUrl,
    query: buildLsQuery(opts),
    intervalMs: opts.intervalMs,
    reverse: opts.reverse,
  });
}
