import { isValidHostName } from "@agmux/protocol";
import type { RemoteConfig } from "./config.ts";

export interface DiscoveredNode { target: string; host: string }
export interface Discovery { list(): Promise<DiscoveredNode[]> }

// `openshell sandbox list -o json` → nodes plus the continuation token. The output is a bare
// array (observed on 0.0.116) or a page `{ sandboxes, next_page_token }` (observed on 0.1.5).
// Entries without a string name, or whose `<gateway>/<name>` host is invalid, or that start
// with "-" (would parse as a flag), are skipped.
export function parseSandboxList(json: string, gateway: string): { nodes: DiscoveredNode[]; next: string } {
  const doc: unknown = JSON.parse(json);
  const page = doc as { sandboxes?: unknown; next_page_token?: unknown } | null;
  const arr = Array.isArray(doc) ? doc : page?.sandboxes;
  if (!Array.isArray(arr)) throw new Error("sandbox list: expected a JSON array or a { sandboxes } page");
  const next = !Array.isArray(doc) && typeof page?.next_page_token === "string" ? page.next_page_token : "";
  const nodes: DiscoveredNode[] = [];
  for (const e of arr) {
    const name = (e as { name?: unknown } | null)?.name;
    if (typeof name !== "string") continue;
    const host = `${gateway}/${name}`;
    if (!name.startsWith("-") && isValidHostName(host)) nodes.push({ target: name, host });
  }
  return { nodes, next };
}

// Bounds paging against a gateway that keeps handing out tokens.
export const MAX_LIST_PAGES = 50;

export function openshellDiscovery(r: RemoteConfig, run: (argv: string[]) => Promise<string>): Discovery {
  const base = [r.openshell_bin, "-g", r.gateway, "sandbox", "list", "-o", "json", "--selector", r.selector];
  return {
    list: async () => {
      const out: DiscoveredNode[] = [];
      let token = "";
      for (let i = 0; i < MAX_LIST_PAGES; i++) {
        // --page-token only on follow-up pages, so clients without paging see the original argv.
        const page = parseSandboxList(await run(token ? [...base, "--page-token", token] : base), r.gateway);
        out.push(...page.nodes);
        if (!page.next || page.next === token) return out;
        token = page.next;
      }
      throw new Error(`sandbox list: more than ${MAX_LIST_PAGES} pages`);
    },
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
