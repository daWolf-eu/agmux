import { defaultRexExec, rexTarget, type RexExec } from "@agmux/wrapper";

export interface RexRowRef { tmux_session: string | null; tmux_pane: string | null; tmux_socket: string | null }

const DEFAULT_MAX = 65536;
const SLOW_MS = 250;
const SLOW_DELAY_MS = 1000;

function parse(s: string): any {
  try { return JSON.parse(s); } catch { return null; }
}

async function call(row: RexRowRef, exec: RexExec, method: string, args?: object): Promise<any> {
  const argv = [
    ...rexTarget(row.tmux_socket), "block", "call", method,
    ...(args ? [JSON.stringify(args)] : []),
    "-s", row.tmux_session ?? "", "-b", row.tmux_pane ?? "",
  ];
  const r = await exec(argv);
  return r.code === 0 ? parse(r.stdout) : null;
}

/**
 * Last `maxBytes` of a block's scrollback without ever fetching all of it. `format` returns the HEAD
 * of the text plus an id when more remains; the tail comes from `blob_read` at total - maxBytes.
 * "" on any failure.
 */
export async function rexTail(row: RexRowRef, maxBytes = DEFAULT_MAX, exec: RexExec = defaultRexExec): Promise<string> {
  try {
    if (!row.tmux_session || !row.tmux_pane) return "";
    const f = await call(row, exec, "format", { format: "text", max_bytes: maxBytes });
    if (!f || typeof f.content !== "string") return "";
    if (f.id == null || typeof f.total !== "number" || f.total <= maxBytes) return f.content;
    let offset = f.total - maxBytes;
    let out = "";
    for (let i = 0; i < 64; i++) {
      const b = await call(row, exec, "blob_read", { id: f.id, offset, max_bytes: maxBytes });
      if (!b || typeof b.data !== "string") return "";
      // An offset inside a multi-byte character leaves 1-3 stray bytes, each decoded as its own
      // U+FFFD (3 bytes encoded) but only 1 byte on the wire: drop them and count them as 1.
      const stray = /^\uFFFD*/.exec(b.data)![0].length;
      out += b.data.slice(stray);
      if (b.eof) return out;
      const n = Buffer.byteLength(b.data) - 2 * stray;
      if (n <= 0) return "";
      offset += n;
    }
    return "";
  } catch {
    return "";
  }
}

export async function rexTitle(row: RexRowRef, exec: RexExec = defaultRexExec): Promise<string | null> {
  try {
    if (!row.tmux_session || !row.tmux_pane) return null;
    const j = await call(row, exec, "title");
    const t = typeof j === "string" ? j : j?.title;
    return typeof t === "string" ? t : null;
  } catch {
    return null;
  }
}

/** Per-block back-off: a block whose last read was slow is polled no faster than once a second. */
export class RexPoll {
  private slow = new Set<string>();
  delayMs(blockId: string, baseMs: number): number {
    return this.slow.has(blockId) ? Math.max(baseMs, SLOW_DELAY_MS) : baseMs;
  }
  record(blockId: string, tookMs: number): void {
    if (tookMs > SLOW_MS) this.slow.add(blockId);
    else this.slow.delete(blockId);
  }
}
