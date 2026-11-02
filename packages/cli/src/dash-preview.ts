import type { SessionRow } from "@agmux/protocol";
import { LIVE_STATUSES, rowMux, tmuxSocketArgs } from "@agmux/protocol";
import { defaultRexExec, type RexExec } from "@agmux/wrapper";
import { RexPoll, rexTail } from "./rex-io.ts";
import type { PreviewSource, UsageSummary } from "@agmux/tui";

export function buildCapturePaneArgs(pane: string, socket: string | null = null): string[] {
  // -p prints the pane content to stdout; -t targets the (server-global) pane id.
  return [...tmuxSocketArgs(socket), "capture-pane", "-p", "-t", pane];
}

// Injectable so tests don't shell out. Default spawns tmux (dynamic args, so
// Bun.spawn rather than Bun.$ which needs static template literals).
export type TmuxText = (args: string[]) => Promise<string>;

const defaultTmuxText: TmuxText = async (args) => {
  const proc = Bun.spawn(["tmux", ...args], { stdout: "pipe", stderr: "ignore" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  if (proc.exitCode !== 0) throw new Error(`tmux exit ${proc.exitCode}`);
  return out;
};

interface HubUsageRow {
  input_tokens: number; output_tokens: number; cost_usd: number;
  last_model: string | null; turn_count: number;
}

export function makePreviewSource(hubUrl: string, tmuxText: TmuxText = defaultTmuxText, rexExec: RexExec = defaultRexExec, now: () => number = Date.now): PreviewSource {
  const poll = new RexPoll();
  const last = new Map<string, { at: number; text: string }>();
  return {
    async mirror(row: SessionRow): Promise<string> {
      if (!LIVE_STATUSES.includes(row.status) || !row.tmux_pane) return "";
      if (rowMux(row) === "rex") {
        const id = `${row.tmux_socket ?? ""}|${row.tmux_pane}`;
        const prev = last.get(id);
        const start = now();
        if (prev && start - prev.at < poll.delayMs(id, 0)) return prev.text;
        const text = await rexTail(row, undefined, rexExec);
        const done = now();
        poll.record(id, done - start);
        last.set(id, { at: done, text });
        return text;
      }
      return tmuxText(buildCapturePaneArgs(row.tmux_pane, row.tmux_socket));
    },
    async usage(row: SessionRow): Promise<UsageSummary | null> {
      const r = await fetch(`${hubUrl}/sessions/${row.session_id}`);
      if (!r.ok) throw new Error(`hub error ${r.status}`);
      const { usage } = (await r.json()) as { usage: HubUsageRow | null };
      if (!usage) return null;
      return {
        input_tokens: usage.input_tokens, output_tokens: usage.output_tokens,
        cost_usd: usage.cost_usd, last_model: usage.last_model, turn_count: usage.turn_count,
      };
    },
  };
}
