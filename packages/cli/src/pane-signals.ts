import type { IngestEnvelope, SessionRow } from "@agmux/protocol";
import { LIVE_STATUSES, TITLE_KEEPALIVE_MS, TitleSignal, tmuxSocketArgs } from "@agmux/protocol";

// Attention signals notifyd derives from tmux, for what hooks cannot see:
//   - the agent's pane title for NATIVE sessions (the PTY wrapper reports its
//     own sessions' titles straight from the OSC stream), and
//   - "the turn ended while you were watching": a `done` session whose pane a
//     focused client is showing is marked seen right away.
// Both become ordinary events into the hub.

export type Capture = (cmd: string, args: string[]) => Promise<string>;

function socketKey(s: string | null | undefined): string { return s ?? ""; }

function bySocket(rows: SessionRow[]): Map<string, SessionRow[]> {
  const out = new Map<string, SessionRow[]>();
  for (const r of rows) {
    const k = socketKey(r.tmux_socket);
    const list = out.get(k);
    if (list) list.push(r); else out.set(k, [r]);
  }
  return out;
}

// pane id → title for every pane on one tmux server; empty if tmux is absent.
export async function listPaneTitles(capture: Capture, socket: string | null): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    const text = await capture("tmux", [...tmuxSocketArgs(socket), "list-panes", "-a", "-F", "#{pane_id}\t#{pane_title}"]);
    for (const line of text.split("\n")) {
      const tab = line.indexOf("\t");
      if (tab > 0) out.set(line.slice(0, tab), line.slice(tab + 1));
    }
  } catch { /* no server on that socket */ }
  return out;
}

// Panes shown by a client whose terminal has OS focus. `focused` in
// #{client_flags} needs focus-events on (agmux.tmux sets it); without it no
// client ever reports focus and this is empty — which errs on the side of
// leaving a session `done`, never of hiding one.
export async function focusedPanes(capture: Capture, socket: string | null): Promise<Set<string>> {
  const out = new Set<string>();
  try {
    const text = await capture("tmux", [...tmuxSocketArgs(socket), "list-clients", "-F", "#{client_flags}\t#{pane_id}"]);
    for (const line of text.split("\n")) {
      const [flags, pane] = line.split("\t");
      if (pane && (flags ?? "").split(",").includes("focused")) out.add(pane.trim());
    }
  } catch { /* no server on that socket */ }
  return out;
}

export interface PaneSignalState {
  titles: Map<string, TitleSignal>;
  // session_id → attention_ts we already sent a focus-seen for.
  seenSent: Map<string, string>;
}

export function createPaneSignalState(): PaneSignalState {
  return { titles: new Map(), seenSent: new Map() };
}

export interface PaneSignalDeps {
  capture: Capture;
  host: string;
  now: () => number;
  newId: () => string;
}

function envelope(r: SessionRow, kind: string, payload: unknown, deps: PaneSignalDeps): IngestEnvelope {
  return {
    event_id: deps.newId(), ts: new Date(deps.now()).toISOString(), session_id: r.session_id,
    kind, version: 1, host: deps.host, payload,
  };
}

// One pass over the current rows → the events to ingest. Never throws.
export async function collectPaneSignals(
  state: PaneSignalState, rows: SessionRow[], deps: PaneSignalDeps,
): Promise<IngestEnvelope[]> {
  const out: IngestEnvelope[] = [];
  const present = new Set(rows.map((r) => r.session_id));
  for (const id of [...state.titles.keys()]) if (!present.has(id)) state.titles.delete(id);
  for (const id of [...state.seenSent.keys()]) if (!present.has(id)) state.seenSent.delete(id);

  const inTmux = rows.filter((r) => r.tmux_pane && LIVE_STATUSES.includes(r.status));

  // Titles: native sessions only — a wrapper session's title already arrives
  // from the PTY stream, without polling.
  for (const [sock, group] of bySocket(inTmux.filter((r) => r.origin === "native"))) {
    const titles = await listPaneTitles(deps.capture, sock || null);
    for (const r of group) {
      const raw = titles.get(r.tmux_pane!);
      if (raw === undefined) continue;
      let sig = state.titles.get(r.session_id);
      if (!sig) { sig = new TitleSignal(r.agent_kind, TITLE_KEEPALIVE_MS); state.titles.set(r.session_id, sig); }
      const payload = sig.observe(raw, deps.now());
      if (payload) out.push(envelope(r, "title.changed", payload, deps));
    }
  }

  // Finished while you were watching: nothing left to see.
  const done = inTmux.filter((r) => r.status === "done" && state.seenSent.get(r.session_id) !== (r.attention_ts ?? ""));
  for (const [sock, group] of bySocket(done)) {
    const focused = await focusedPanes(deps.capture, sock || null);
    for (const r of group) {
      if (!focused.has(r.tmux_pane!)) continue;
      state.seenSent.set(r.session_id, r.attention_ts ?? "");
      out.push(envelope(r, "session.seen", { source: "focus" }, deps));
    }
  }
  return out;
}
