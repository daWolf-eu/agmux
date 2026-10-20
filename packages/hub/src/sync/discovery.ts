import { isValidHostName } from "@agmux/protocol";
import type { RemoteConfig } from "./config.ts";

export interface DiscoveredNode { target: string; host: string }
export interface Discovery { list(): Promise<DiscoveredNode[]> }

// `openshell sandbox list -o json` → nodes. Entries without a string name, or
// whose `<gateway>/<name>` host is invalid, or that start with "-" (would parse as a flag), are skipped.
export function parseSandboxList(json: string, gateway: string): DiscoveredNode[] {
  const arr: unknown = JSON.parse(json);
  if (!Array.isArray(arr)) throw new Error("sandbox list: expected a JSON array");
  const out: DiscoveredNode[] = [];
  for (const e of arr) {
    const name = (e as { name?: unknown } | null)?.name;
    if (typeof name !== "string") continue;
    const host = `${gateway}/${name}`;
    if (!name.startsWith("-") && isValidHostName(host)) out.push({ target: name, host });
  }
  return out;
}

export function openshellDiscovery(r: RemoteConfig, run: (argv: string[]) => Promise<string>): Discovery {
  return {
    list: async () => parseSandboxList(
      await run([r.openshell_bin, "-g", r.gateway, "sandbox", "list", "-o", "json", "--selector", r.selector]),
      r.gateway),
  };
}

// Default `run`: stdout of the command. Rejects on non-zero exit (stderr in the message)
// and, after timeoutMs, kills the child so a stuck gateway can't freeze the sync loop.
export async function runCapture(argv: string[], opts: { timeoutMs?: number } = {}): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const p = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; p.kill("SIGKILL"); }, timeoutMs);
  try {
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    if (timedOut) throw new Error(`${argv[0]} timed out after ${timeoutMs} ms`);
    if (code !== 0) throw new Error(`${argv[0]} exited ${code}: ${err.trim()}`);
    return out;
  } finally {
    clearTimeout(timer);
  }
}
