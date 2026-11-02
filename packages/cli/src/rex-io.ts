import { defaultRexExec, rexTarget, type RexExec } from "@agmux/wrapper";
import { defaultSleep, type InjectOpts, type InjectPrimitives } from "./tmux-inject.ts";

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

const CAPTURE_BYTES = 16384;
const REX_POLL_MS = 500;

/**
 * Inject primitives for a Rex block. Keys go through `block send-key`; the prompt goes through
 * `block.event` paste on stdin (never argv, so size and quoting don't matter).
 */
export function rexPrimitives(row: { session: string; socket: string | null }, exec: RexExec = defaultRexExec): InjectPrimitives {
  const g = rexTarget(row.socket);
  const must = async (argv: string[], stdin?: Uint8Array): Promise<void> => {
    const r = await exec(argv, stdin);
    if (r.code !== 0) throw new Error(`rex ${argv.filter((a) => !a.startsWith("-") && a !== "unix").slice(0, 3).join(" ")} failed (exit ${r.code})`);
  };
  const keys = (pane: string, ...k: string[]) => must([...g, "block", "send-key", "-s", row.session, "-b", pane, ...k]);
  return {
    capture: (pane) => rexTail({ tmux_session: row.session, tmux_pane: pane, tmux_socket: row.socket }, CAPTURE_BYTES, exec),
    clearLine: (pane) => keys(pane, "ctrl+a", "ctrl+k"),
    // sanitizePayload encodes newlines as CR for tmux's bracketed paste; Rex's paste takes plain "\n".
    paste: (pane, bytes) => {
      const text = new TextDecoder().decode(bytes).replace(/\r/g, "\n");
      const body = JSON.stringify({ session_id: row.session, block_id: pane, event: { type: "paste", payload: { text } } });
      return must([...g, "api", "call", "-s", row.session, "block.event", "-"], new TextEncoder().encode(body));
    },
    submit: (pane) => keys(pane, "enter"),
  };
}

/** Inject options for a Rex block: Rex primitives, polling every 500 ms and backing off to 1 s once a read is slow. */
export function rexInjectOpts(opts: InjectOpts, session: string, exec: RexExec = defaultRexExec): InjectOpts {
  const base = rexPrimitives({ session, socket: opts.socket ?? null }, exec);
  const poll = new RexPoll();
  const primitives: InjectPrimitives = {
    ...base,
    capture: async (pane) => {
      const t0 = Date.now();
      const out = await base.capture(pane);
      poll.record(pane, Date.now() - t0);
      return out;
    },
  };
  const sleep = opts.sleep ?? defaultSleep;
  return {
    ...opts, primitives,
    pollIntervalMs: opts.pollIntervalMs ?? REX_POLL_MS,
    sleep: (ms) => sleep(poll.delayMs(opts.pane, ms)),
  };
}
