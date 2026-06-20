/** @jsxImportSource @opentui/react */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { LIVE_STATUSES, type SessionRow, type EventEnvelope } from "@agmux/protocol";
import type { SessionFeed } from "../feed.ts";
import type { Actions, Handoff, PreviewMode, PreviewSource, UsageSummary } from "../types.ts";
import { sortRows, nextSort, type SortKey } from "../shared/sort.ts";
import { filterRows } from "../shared/filter.ts";
import { matchAttachedPane } from "./attached.ts";
import { HeaderBar } from "./HeaderBar.tsx";
import { SessionTable } from "./SessionTable.tsx";
import { PreviewPane } from "./PreviewPane.tsx";
import { FooterBar } from "./FooterBar.tsx";

export interface DashAppProps {
  feed: SessionFeed;
  source: PreviewSource;
  actions: Actions;
  hubUrl: string;
  defaultPreview: PreviewMode;
  intervalMs: number;
  onHandoff: (h: Handoff) => void;
  onQuit: () => void;
  // best-effort active pane id from the parent tmux client (Task 15); null when unknown
  activePane?: string | null;
}

const MODES: PreviewMode[] = ["mirror", "events", "detail"];

export function DashApp(props: DashAppProps) {
  const { feed, hubUrl } = props;

  const { height } = useTerminalDimensions();

  // Feed → rows via useSyncExternalStore (synchronous notify; same as Ink path).
  const snapRef = useRef<{ rows: SessionRow[] | null; error: string | null }>({ rows: null, error: null });
  const subscribe = useCallback(
    (notify: () => void) =>
      feed.subscribe(
        (r) => { snapRef.current = { rows: r, error: null }; notify(); },
        (e) => { snapRef.current = { ...snapRef.current, error: e.message }; notify(); },
      ),
    [feed],
  );
  const getSnap = useCallback(() => snapRef.current, []);
  const { rows, error } = useSyncExternalStore(subscribe, getSnap);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<PreviewMode>(props.defaultPreview);
  const [sortKey, setSortKey] = useState<SortKey>("status");
  const [filter, setFilter] = useState("");
  const [filtering, setFiltering] = useState(false);
  const [confirmKill, setConfirmKill] = useState<SessionRow | null>(null);
  const [showHelp, setShowHelp] = useState(false);

  const visible = useMemo(() => sortRows(filterRows(rows ?? [], filter), sortKey), [rows, filter, sortKey]);
  const attachedId = useMemo(() => matchAttachedPane(visible, props.activePane ?? null), [visible, props.activePane]);

  const effectiveSelectedId =
    selectedId && visible.some((r) => r.session_id === selectedId)
      ? selectedId
      : (visible[0]?.session_id ?? null);
  const selected = visible.find((r) => r.session_id === effectiveSelectedId) ?? null;

  // Async-decoupled preview buffers — live, tagged by session_id.
  const [mirror, setMirror] = useState<{ id: string | null; text: string }>({ id: null, text: "" });
  const [eventsBuf, setEventsBuf] = useState<{ id: string | null; list: EventEnvelope[] }>({ id: null, list: [] });
  const [usageBuf, setUsageBuf] = useState<{ id: string | null; data: UsageSummary | null }>({ id: null, data: null });

  const canMirror = (r: SessionRow | null) => !!r && LIVE_STATUSES.includes(r.status) && !!r.tmux_pane;
  const effectiveMode: PreviewMode = mode === "mirror" && !canMirror(selected) ? "events" : mode;

  const selRef = useRef<SessionRow | null>(selected);
  selRef.current = selected;
  const PREVIEW_DEBOUNCE_MS = 80;
  useEffect(() => {
    if (!selected) return;
    let stop = false;
    const pull = async () => {
      const row = selRef.current;
      if (!row) return;
      try {
        if (effectiveMode === "mirror") { const t = await props.source.mirror(row); if (!stop) setMirror({ id: row.session_id, text: t }); }
        else if (effectiveMode === "events") { const e = await props.source.events(row); if (!stop) setEventsBuf({ id: row.session_id, list: e }); }
        else { const u = await props.source.usage(row); if (!stop) setUsageBuf({ id: row.session_id, data: u }); }
      } catch { /* keep last good */ }
    };
    const lead = setTimeout(() => { void pull(); }, PREVIEW_DEBOUNCE_MS);
    const timer = setInterval(pull, props.intervalMs);
    return () => { stop = true; clearTimeout(lead); clearInterval(timer); };
  }, [effectiveSelectedId, effectiveMode, props.intervalMs, props.source, selected]);

  const move = (delta: number) => {
    if (visible.length === 0) return;
    const i = Math.max(0, visible.findIndex((r) => r.session_id === effectiveSelectedId));
    const next = Math.min(visible.length - 1, Math.max(0, i + delta));
    setSelectedId(visible[next]!.session_id);
  };

  useKeyboard((key) => {
    if (filtering) {
      if (key.name === "return" || key.name === "escape") { setFiltering(false); return; }
      if (key.name === "backspace") { setFilter((f) => f.slice(0, -1)); return; }
      if (key.sequence && key.sequence.length === 1 && !key.ctrl && !key.meta) setFilter((f) => f + key.sequence);
      return;
    }
    if (confirmKill) {
      if (key.name === "y") { void props.actions.kill(confirmKill); setConfirmKill(null); }
      else if (key.name === "n" || key.name === "escape") setConfirmKill(null);
      return;
    }
    if (showHelp) { if (key.name === "escape" || key.name === "q" || key.name === "?") setShowHelp(false); return; }

    if (key.name === "q") { props.onQuit(); return; }
    if (key.name === "?") { setShowHelp(true); return; }
    if (key.name === "j" || key.name === "down") { move(1); return; }
    if (key.name === "k" || key.name === "up") { move(-1); return; }
    if (key.name === "g") { setSelectedId(visible[0]?.session_id ?? null); return; }
    if (key.name === "G") { setSelectedId(visible[visible.length - 1]?.session_id ?? null); return; }
    if (key.name === "s") { setSortKey((k) => nextSort(k)); return; }
    if (key.name === "tab") { setMode((m) => MODES[(MODES.indexOf(m) + 1) % MODES.length]!); return; }
    if (key.name === "/") { setFilter(""); setFiltering(true); return; }
    if (key.name === "return" && selected) {
      void props.actions.attach(selected).then((h) => { if (h) { props.onHandoff(h); props.onQuit(); } });
      return;
    }
    if (key.name === "x" && selected && LIVE_STATUSES.includes(selected.status)) { setConfirmKill(selected); return; }
  });

  const now = Date.now();
  // Body height budget: total minus header(1) + table/preview borders + footer(1).
  const bodyHeight = Math.max(3, height - 4);

  if (showHelp) {
    return (
      <box style={{ flexDirection: "column", border: true }} title="agmux dash — keys">
        <text>j/k move · g/G top/bottom · s sort · / filter</text>
        <text>tab preview · ⏎ attach · x kill · ? help · q quit</text>
        <text fg="#6c7086">? or esc to close</text>
      </box>
    );
  }

  return (
    <box style={{ flexDirection: "column", width: "100%", height: "100%" }}>
      <HeaderBar rows={visible} connected={!error} hubUrl={hubUrl} />
      <box style={{ flexDirection: "row", flexGrow: 1 }}>
        <box style={{ flexGrow: 1, border: true }} title="Sessions">
          {rows === null
            ? <text fg="#6c7086">connecting to {hubUrl}…</text>
            : <SessionTable rows={visible} selectedId={effectiveSelectedId} attachedId={attachedId} now={now} height={bodyHeight} onSelect={setSelectedId} />}
        </box>
        <box style={{ width: "45%", border: true }} title={effectiveMode[0]!.toUpperCase() + effectiveMode.slice(1)}>
          <PreviewPane
            row={selected} mode={effectiveMode}
            mirrorText={mirror.id === effectiveSelectedId ? mirror.text : ""}
            events={eventsBuf.id === effectiveSelectedId ? eventsBuf.list : []}
            usage={usageBuf.id === effectiveSelectedId ? usageBuf.data : null}
            maxBodyLines={bodyHeight}
          />
        </box>
      </box>
      <FooterBar error={error} filtering={filtering} filter={filter} confirmKill={confirmKill?.session_id.slice(0, 13) ?? null} />
    </box>
  );
}
