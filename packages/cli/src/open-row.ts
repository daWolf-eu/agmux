// What opening a row does, across Rex and tmux (spec §5.2, §5.3): one decision,
// shared by `agmux attach` and the dash.
import { $ } from "bun";
import { AGMUX_TMUX_SESSION_DEFAULT, rowMux, type MuxKind, type SessionRow } from "@agmux/protocol";
import { defaultRexExec, type RexExec } from "@agmux/wrapper";
import type { Handoff } from "@agmux/tui";
import { findLabelledBlock, rexFocus, rexNewLabelledTab, rexPresence, type Presence } from "./rex-place.ts";
import { buildAttachCommands } from "./attach.ts";
import { holdOnFailure } from "./tmux-place.ts";
import type { PaneCoords } from "./tmux-place.ts";

export { pickClient, rexFocus, rexPresence, type Presence } from "./rex-place.ts";

export type OpenPlan = "tmux-native" | "tmux-tab" | "focus-rex" | "resume" | "unreachable";

// Unreachable comes first: a hung server may still be running the agent, and a
// resume would put two agents under one session_id. Only "gone" resumes.
export function planOpen(a: { caller: MuxKind | null; row: MuxKind; live: boolean; presence: Presence }): OpenPlan {
  if (a.presence === "unreachable") return "unreachable";
  if (!a.live || a.presence === "gone") return "resume";
  if (a.row === "rex") return "focus-rex";
  if (a.caller === "rex") return "tmux-tab";
  return "tmux-native";
}

// Is the row's pane still there? A Rex row asks the server it lives on; a tmux
// row only knows present and gone.
export async function probeRow(
  row: Pick<SessionRow, "mux" | "tmux_session" | "tmux_pane" | "tmux_socket">,
  tmuxExists: (name: string, socket: string | null) => Promise<boolean>,
  exec: RexExec = defaultRexExec,
): Promise<Presence> {
  if (rowMux(row) === "rex") return rexPresence(row, exec);
  return (await tmuxExists(row.tmux_session!, row.tmux_socket)) ? "present" : "gone";
}

export const rexUnreachableMessage = (sessionId: string): string =>
  `Rex server unreachable; not resuming ${sessionId.slice(0, 8)}`;

export interface OpenRexOpts {
  caller: MuxKind | null;
  popup: boolean;
  currentPane: () => Promise<PaneCoords | null>; // in a popup, the block under the float
}

// Focus a live Rex row. Inside Rex: a popup closes onto it, an inline dash stays.
// Outside Rex the agent opens elsewhere, so success is reported, not seen.
export async function openRexRow(row: SessionRow, o: OpenRexOpts, exec: RexExec = defaultRexExec): Promise<Handoff | null> {
  const here = o.caller === "rex" ? await o.currentPane() : null;
  const result = await rexFocus(
    { session: row.tmux_session!, window: row.tmux_window, pane: row.tmux_pane!, socket: row.tmux_socket },
    here ? { block: here.pane, server: here.socket } : null,
    exec,
  );
  if (result === "no-app") throw new Error("Rex app not running");
  if (result === "focused-only") return { argv: [], notice: "opened in Rex; several Rex apps connected, could not switch" };
  if (o.caller !== "rex") return { argv: [], notice: "opened in Rex" };
  return o.popup ? { argv: [] } : null;
}

// One tab per tmux session (not per row): the label is a fixed-shape hash so
// odd session names never reach it.
export function tmuxTabLabel(socket: string | null, session: string): string {
  const h = BigInt(Bun.hash(`${socket ?? ""}\0${session}`)).toString(36).padStart(8, "0").slice(0, 8);
  return `agmux:tmux:${h}`;
}

const runTmuxDefault = async (args: string[]): Promise<void> => { await $`tmux ${args}`.quiet(); };

// A live tmux row opened from Rex: a tab in the caller's session that attaches to
// it, or, when the tab exists, focus it and move the attached tmux client to the
// row's window and pane. Rex calls go to the caller's server, tmux calls to the row's socket.
export async function openTmuxTab(
  row: SessionRow,
  o: OpenRexOpts,
  exec: RexExec = defaultRexExec,
  runTmux: (args: string[]) => Promise<void> = runTmuxDefault,
): Promise<Handoff | null> {
  const here = await o.currentPane();
  if (!here) throw new Error("not inside a Rex block; cannot open a tmux tab");
  const coords = { tmux_session: row.tmux_session!, tmux_window: row.tmux_window!, tmux_pane: row.tmux_pane, tmux_socket: row.tmux_socket };
  const attach = buildAttachCommands(coords, false)[0]!;
  const label = tmuxTabLabel(row.tmux_socket, row.tmux_session!);

  const existing = await findLabelledBlock(here.session, label, here.socket, exec);
  if (existing) {
    await rexFocus({ session: here.session, window: null, pane: existing, socket: here.socket }, { block: here.pane, server: here.socket }, exec);
    // Everything after attach-session's `-t <session>` is the `;`-chained selects.
    const sock = attach.slice(0, attach.indexOf("attach-session"));
    const rest = attach.slice(attach.indexOf(";") + 1);
    let cmd: string[] = [];
    for (const a of [...rest, ";"]) {
      if (a === ";") { if (cmd.length) await runTmux([...sock, ...cmd]); cmd = []; } else cmd.push(a);
    }
  } else {
    await rexNewLabelledTab({ session: here.session, label, cmd: holdOnFailure(["tmux", ...attach]), env: {}, socket: here.socket }, exec);
  }
  return o.popup ? { argv: [] } : null;
}

// The session a resume opens in when the caller is in a multiplexer. A row's
// tmux_session is only a tmux name on a tmux row, and never names anything in
// Rex; on a Rex row it's a UUID tmux must not see.
export function resumeTarget(
  row: Pick<SessionRow, "mux" | "tmux_session">,
  caller: MuxKind | null,
  here: PaneCoords | null,
  env: Record<string, string | undefined>,
): string {
  if (here) return here.session;
  if (caller === "rex") return env.REX_SESSION ?? AGMUX_TMUX_SESSION_DEFAULT;
  return (rowMux(row) === "tmux" ? row.tmux_session : null) ?? AGMUX_TMUX_SESSION_DEFAULT;
}
