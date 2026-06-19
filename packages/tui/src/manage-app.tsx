import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import { LIVE_STATUSES, TERMINAL_STATUSES, type SessionRow, type EventEnvelope } from "@agmux/protocol";
import type { SessionFeed } from "./feed.ts";
import type { Actions, Handoff, PreviewMode, PreviewSource, UsageSummary } from "./types.ts";
import { selectableRows, groupSessions, matchesFilter } from "./group-table.ts";
import { SessionList } from "./session-list.tsx";
import { Preview } from "./preview.tsx";
import { FOOTER_HINT, HELP_LINES } from "./keymap.ts";

export interface ManageAppProps {
  feed: SessionFeed;
  source: PreviewSource;
  actions: Actions;
  hubUrl: string;
  defaultPreview: PreviewMode;
  intervalMs: number;
  onHandoff: (h: Handoff) => void;
  // test injection
  setIntervalImpl?: typeof setInterval;
  clearIntervalImpl?: typeof clearInterval;
}

function canMirror(r: SessionRow): boolean {
  return LIVE_STATUSES.includes(r.status) && !!r.tmux_pane;
}

const MODES: PreviewMode[] = ["mirror", "events", "detail"];

// Hold off the leading preview fetch this long after the selection changes, so
// scrolling through rows with j/k doesn't spawn a tmux capture-pane per row —
// only the row you settle on is fetched. Short enough to feel instant.
const PREVIEW_DEBOUNCE_MS = 80;

// Stable empty list so the memoized Preview isn't handed a fresh [] each render
// (which would defeat the memo) when no events belong to the current selection.
const NO_EVENTS: EventEnvelope[] = [];

export function ManageApp(props: ManageAppProps) {
  const { feed, source, actions, hubUrl, defaultPreview, intervalMs, onHandoff } = props;
  const setIntervalImpl = props.setIntervalImpl ?? setInterval;
  const clearIntervalImpl = props.clearIntervalImpl ?? clearInterval;
  const { exit } = useApp();

  // Track terminal size to bound the layout: the preview is clamped so the whole
  // frame stays strictly *under* the viewport. Ink full-clears the screen (visible
  // flicker) only when a frame overflows the viewport or crosses the fullscreen
  // boundary — keeping every frame under it avoids that entirely while letting the
  // frame shrink (fast repaint) while navigating. Falls back to 24×80 in tests.
  const { stdout } = useStdout();
  const [termRows, setTermRows] = useState(() => stdout?.rows || 24);
  const [termCols, setTermCols] = useState(() => stdout?.columns || 80);
  useEffect(() => {
    if (!stdout) return;
    const onResize = () => { setTermRows(stdout.rows || 24); setTermCols(stdout.columns || 80); };
    stdout.on("resize", onResize);
    return () => { stdout.off("resize", onResize); };
  }, [stdout]);

  // Use useSyncExternalStore so the feed subscription notifies React synchronously
  // (avoids the DefaultLane async-scheduler path that would require 2 event-loop
  // turns when called outside of React's discreteUpdates context).
  const feedSnapshotRef = useRef<{ rows: SessionRow[] | null; error: string | null }>({ rows: null, error: null });
  const subscribeFeed = useCallback((notify: () => void) => feed.subscribe(
    (r) => { feedSnapshotRef.current = { rows: r, error: null }; notify(); },
    (e) => { feedSnapshotRef.current = { ...feedSnapshotRef.current, error: e.message }; notify(); },
  ), [feed]);
  const getFeedSnapshot = useCallback(() => feedSnapshotRef.current, [feed]); // eslint-disable-line react-hooks/exhaustive-deps
  const { rows, error } = useSyncExternalStore(subscribeFeed, getFeedSnapshot);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<PreviewMode>(defaultPreview);
  const [split, setSplit] = useState(0.55); // table width fraction
  const [filter, setFilter] = useState("");
  const [filtering, setFiltering] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [confirmKill, setConfirmKill] = useState<SessionRow | null>(null);

  // Each preview buffer is tagged with the session it was fetched for. We only
  // surface it when the tag matches the current selection, so a buffer captured
  // for the previous row is never shown under the new row's header (that swap
  // was the visible flicker). A mismatch renders empty until the fetch lands.
  const [mirror, setMirror] = useState<{ id: string | null; text: string }>({ id: null, text: "" });
  const [eventsBuf, setEventsBuf] = useState<{ id: string | null; list: EventEnvelope[] }>({ id: null, list: [] });
  const [usageBuf, setUsageBuf] = useState<{ id: string | null; data: UsageSummary | null }>({ id: null, data: null });

  const visible = useMemo(() => (rows ?? []).filter((r) => matchesFilter(r, filter)), [rows, filter]);
  const flat = useMemo(() => selectableRows(visible), [visible]);

  // Derive effective selection inline so it's valid immediately after rows arrive
  // (avoids a secondary useEffect cycle that would delay selection by one render).
  // `selectedId` stores the user's explicit choice; effectiveSelectedId falls back
  // to flat[0] when selectedId is absent or no longer in the visible list.
  const effectiveSelectedId =
    (selectedId && flat.some((r) => r.session_id === selectedId))
      ? selectedId
      : (flat[0]?.session_id ?? null);

  const selected = flat.find((r) => r.session_id === effectiveSelectedId) ?? null;
  const effectiveMode: PreviewMode = mode === "mirror" && (!selected || !canMirror(selected)) ? "events" : mode;

  // Only show a buffer that belongs to the current selection (see setMirror).
  const mirrorText = mirror.id === effectiveSelectedId ? mirror.text : "";
  const events = eventsBuf.id === effectiveSelectedId ? eventsBuf.list : NO_EVENTS;
  const usage = usageBuf.id === effectiveSelectedId ? usageBuf.data : null;

  // Preview polling — re-runs when selection or resolved mode changes.
  const selRef = useRef<SessionRow | null>(selected);
  selRef.current = selected;
  useEffect(() => {
    if (!selected) return;
    let stop = false;
    const pull = async () => {
      const row = selRef.current;
      if (!row) return;
      try {
        if (effectiveMode === "mirror") { const t = await source.mirror(row); if (!stop) setMirror({ id: row.session_id, text: t }); }
        else if (effectiveMode === "events") { const e = await source.events(row); if (!stop) setEventsBuf({ id: row.session_id, list: e }); }
        else { const u = await source.usage(row); if (!stop) setUsageBuf({ id: row.session_id, data: u }); }
      } catch { /* keep last good */ }
    };
    // Debounce the leading fetch so rapid j/k navigation doesn't spawn a capture
    // per row; the periodic refresh then keeps the settled row's preview live.
    const lead = setTimeout(() => { void pull(); }, PREVIEW_DEBOUNCE_MS);
    const t = setIntervalImpl(pull, intervalMs);
    return () => { stop = true; clearTimeout(lead); clearIntervalImpl(t); };
  }, [effectiveSelectedId, effectiveMode, intervalMs, source]);

  const move = (delta: number) => {
    if (flat.length === 0) return;
    const i = Math.max(0, flat.findIndex((r) => r.session_id === effectiveSelectedId));
    const next = Math.min(flat.length - 1, Math.max(0, i + delta));
    setSelectedId(flat[next]!.session_id);
  };
  const jumpGroup = (delta: number) => {
    const groups = groupSessions(visible);
    const firsts = groups.map((g) => g.rows[0]!.session_id);
    const cur = groups.findIndex((g) => g.rows.some((r) => r.session_id === effectiveSelectedId));
    const next = Math.min(groups.length - 1, Math.max(0, (cur < 0 ? 0 : cur) + delta));
    if (firsts[next]) setSelectedId(firsts[next]!);
  };

  useInput((input, key) => {
    // Filter capture mode takes priority.
    if (filtering) {
      if (key.return || key.escape) { setFiltering(false); return; }
      if (key.backspace || key.delete) { setFilter((f) => f.slice(0, -1)); return; }
      if (input && !key.ctrl && !key.meta) setFilter((f) => f + input);
      return;
    }
    if (confirmKill) {
      if (input === "y") { void actions.kill(confirmKill); setConfirmKill(null); }
      else if (input === "n" || key.escape) setConfirmKill(null);
      return;
    }
    if (showHelp) { if (input === "?" || key.escape || input === "q") setShowHelp(false); return; }

    if (input === "q") { exit(); return; }
    if (input === "?") { setShowHelp(true); return; }
    if (input === "j" || key.downArrow) return move(1);
    if (input === "k" || key.upArrow) return move(-1);
    if (input === "}") return jumpGroup(1);
    if (input === "{") return jumpGroup(-1);
    if (input === ">") return setSplit((s) => Math.min(0.8, s + 0.05));
    if (input === "<") return setSplit((s) => Math.max(0.3, s - 0.05));
    if (key.tab) return setMode((m) => MODES[(MODES.indexOf(m) + 1) % MODES.length]!);
    if (input === "/") { setFilter(""); setFiltering(true); return; }
    if (key.return && selected) { void actions.attach(selected).then((h) => { if (h) { onHandoff(h); exit(); } }); return; }
    if (input === "x" && selected && LIVE_STATUSES.includes(selected.status)) { setConfirmKill(selected); return; }
    if (input === "r" && selected && TERMINAL_STATUSES.includes(selected.status)) {
      void actions.resume(selected).then((h) => { onHandoff(h); exit(); });
      return;
    }
  });

  if (showHelp) {
    return (
      <Box flexDirection="column">
        <Text bold>agmux dash — keys</Text>
        {HELP_LINES.map((l) => <Text key={l}>{l}</Text>)}
        <Text dimColor>? or esc to close</Text>
      </Box>
    );
  }

  const leftCols = Math.round(split * 100);
  const leftPct = `${leftCols}%`;
  const rightPct = `${100 - leftCols}%`;
  // Footer lines below the body (hint, plus the kill/filter prompts when active).
  const footerLines = 1 + (confirmKill ? 1 : 0) + (filtering ? 1 : 0);
  // Bound the preview body so the *whole* frame stays strictly under the viewport
  // (header 2 + body + footer + 1 reserved row). Staying under the viewport — not
  // pinned to it — is what keeps Ink off its full-screen-clear path: the frame is
  // only as tall as its content, so an empty preview while navigating repaints
  // cheaply, and Ink never clears even as the height changes.
  const maxBodyLines = Math.max(1, termRows - footerLines - 2 - 1);
  // Column widths in chars. The left (table) rows are truncated to keep column
  // alignment; the right (preview) lines are hard-wrapped. The -2 covers the
  // 1-col gutter plus a slack column so a full-width line can't spill and wrap.
  const leftWidth = Math.max(1, Math.floor((termCols * leftCols) / 100));
  const rightWidth = Math.max(1, termCols - leftWidth - 2);
  return (
    <Box flexDirection="column">
      <Box>
        <Box width={leftPct} flexDirection="column">
          {rows === null
            ? <Text dimColor>connecting to {hubUrl}…</Text>
            : <SessionList rows={visible} selectedId={effectiveSelectedId} width={leftWidth} />}
        </Box>
        <Box width={rightPct} flexDirection="column" marginLeft={1}>
          <Preview row={selected} mode={effectiveMode} mirrorText={mirrorText} events={events} usage={usage} maxBodyLines={maxBodyLines} bodyWidth={rightWidth} />
        </Box>
      </Box>
      {confirmKill && <Text color="red">kill {confirmKill.session_id.slice(0, 8)} (pid {confirmKill.pid ?? "?"})? y/n</Text>}
      {filtering && <Text>filter: {filter}▏</Text>}
      <Text dimColor>{error ? `hub unreachable — reconnecting… (${error})` : FOOTER_HINT}</Text>
    </Box>
  );
}
