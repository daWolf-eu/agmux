import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type RexExec = (args: string[], stdin?: Uint8Array) => Promise<{ code: number; stdout: string }>;

const MAC_REL = "Library/Application Support/com.superlogical.rex/RexServer/Versions/Current/Rex Server.app/Contents/MacOS/rex";

/** PATH, then $REX_BIN_DIR/rex, then the macOS app location. null = Rex unavailable. */
export function resolveRexBin(
  env: Record<string, string | undefined>,
  exists: (p: string) => boolean = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } },
): string | null {
  const candidates: string[] = [];
  for (const dir of (env.PATH ?? "").split(path.delimiter)) if (dir) candidates.push(path.join(dir, "rex"));
  if (env.REX_BIN_DIR) candidates.push(path.join(env.REX_BIN_DIR, "rex"));
  candidates.push(path.join(env.HOME ?? os.homedir(), MAC_REL));
  return candidates.find((c) => exists(c)) ?? null;
}

/** Global flags for a call that targets a row: never autostart, pin the server, bound the time. */
export function rexTarget(server: string | null, timeout = "2s"): string[] {
  return ["--autostart=false", ...(server ? ["-S", server] : []), "--timeout", timeout];
}

function timeoutMs(args: string[]): number {
  const i = args.indexOf("--timeout");
  const m = i >= 0 ? /^(\d+(?:\.\d+)?)(ms|s|m)?$/.exec(args[i + 1] ?? "") : null;
  const n = m ? Number(m[1]) * (m[2] === "ms" ? 1 : m[2] === "m" ? 60000 : 1000) : 10000;
  return n + 2000; // grace over rex's own timeout
}

export const defaultRexExec: RexExec = async (args, stdin) => {
  const bin = resolveRexBin(process.env);
  if (!bin) return { code: 127, stdout: "" };
  try {
    const proc = Bun.spawn([bin, ...args], {
      stdin: stdin ? new Blob([stdin]) : "ignore", stdout: "pipe", stderr: "ignore",
    });
    let killed = false;
    const timer = setTimeout(() => { killed = true; try { proc.kill(); } catch {} }, timeoutMs(args));
    try {
      const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      return { code: killed ? 124 : code, stdout };
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return { code: 127, stdout: "" };
  }
};

export interface RexCoords { session: string; window: string | null; pane: string; socket: string | null; label: string | null }

function parse(stdout: string): any {
  try { return JSON.parse(stdout); } catch { return null; }
}

export async function readCurrentRexCoords(
  env: Record<string, string | undefined>,
  exec: RexExec = defaultRexExec,
): Promise<RexCoords | null> {
  const session = env.REX_SESSION;
  const pane = env.REX_BLOCK;
  if (!session || !pane) return null;
  const socket = env.REX_SERVER || null;
  const g = rexTarget(socket);

  let window: string | null = null;
  const who = await exec([...g, "whoami", "--json"]);
  const w = who.code === 0 ? parse(who.stdout) : null;
  // whoami reporting a different location than the env means trust the env ids.
  if (w && w.session_id === session && w.block_id === pane && typeof w.window_id === "string") window = w.window_id;

  let label: string | null = null;
  const ls = await exec([...g, "ls", "--json"]);
  const l = ls.code === 0 ? parse(ls.stdout) : null;
  const hit = Array.isArray(l?.sessions) ? l.sessions.find((s: any) => s?.session_id === session) : null;
  if (hit && typeof hit.label === "string") label = hit.label;

  return { session, window, pane, socket, label };
}
