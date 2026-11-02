import type { RexExec } from "@agmux/wrapper";

/** Strip leading global flags (--autostart=..., -S v, --timeout v). */
function stripGlobals(args: string[]): string[] {
  let i = 0;
  while (i < args.length) {
    const a = args[i]!;
    if (a.startsWith("--autostart")) i += 1;
    else if (a === "-S" || a === "--timeout") i += 2;
    else break;
  }
  return args.slice(i);
}

/** Fake RexExec keyed by the joined args after the global flags, e.g. "ls --json". Unknown commands exit 4. */
export function fakeRex(script: Record<string, { code?: number; stdout?: string }>): RexExec & { calls: string[][] } {
  const calls: string[][] = [];
  const fn = (async (args: string[]) => {
    calls.push(args);
    const hit = script[stripGlobals(args).join(" ")];
    return hit ? { code: hit.code ?? 0, stdout: hit.stdout ?? "" } : { code: 4, stdout: "" };
  }) as RexExec & { calls: string[][] };
  fn.calls = calls;
  return fn;
}
