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

export function ManageApp(props: ManageAppProps) {
  const { feed, source, actions, hubUrl, defaultPreview, intervalMs, onHandoff } = props;
  const setIntervalImpl = props.setIntervalImpl ?? setInterval;
  const clearIntervalImpl = props.clearIntervalImpl ?? clearInterval;
  const { exit } = useApp();

  // Track terminal height so we can pin the layout to the viewport: the table
  // and the preview's tabs/separator stay fixed while only the preview body is
  // clipped. Falls back to 24 rows when stdout doesn't report a size (tests).
  const { stdout } = useStdout();
  const [termRows, setTermRows] = useState(() => stdout?.rows || 24);
  useEffect(() => {
    if (!stdout) return;
    const onResize = () => setTermRows(stdout.rows || 24);
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

  const [mirrorText, setMirrorText] = useState("");
  const [events, setEvents] = useState<EventEnvelope[]>([]);
  const [usage, setUsage] = useState<UsageSummary | null>(null);

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
        if (effectiveMode === "mirror") { const t = await source.mirror(row); if (!stop) setMirrorText(t); }
        else if (effectiveMode === "events") { const e = await source.events(row); if (!stop) setEvents(e); }
        else { const u = await source.usage(row); if (!stop) setUsage(u); }
      } catch { /* keep last good */ }
    };
    void pull();
    const t = setIntervalImpl(pull, intervalMs);
    return () => { stop = true; clearIntervalImpl(t); };
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

  const leftPct = `${Math.round(split * 100)}%`;
  const rightPct = `${100 - Math.round(split * 100)}%`;
  // Footer lines below the body (hint, plus the kill/filter prompts when active).
  const footerLines = 1 + (confirmKill ? 1 : 0) + (filtering ? 1 : 0);
  const bodyHeight = Math.max(1, termRows - footerLines);
  // Preview reserves 2 lines for its tabs + separator header before the body.
  const maxBodyLines = Math.max(1, bodyHeight - 2);
  return (
    <Box flexDirection="column" height={termRows}>
      <Box flexGrow={1} overflow="hidden">
        <Box width={leftPct} flexDirection="column" overflow="hidden">
          {rows === null
            ? <Text dimColor>connecting to {hubUrl}…</Text>
            : <SessionList rows={visible} selectedId={effectiveSelectedId} />}
        </Box>
        <Box width={rightPct} flexDirection="column" marginLeft={1} overflow="hidden">
          <Preview row={selected} mode={effectiveMode} mirrorText={mirrorText} events={events} usage={usage} maxBodyLines={maxBodyLines} />
        </Box>
      </Box>
      {confirmKill && <Text color="red">kill {confirmKill.session_id.slice(0, 8)} (pid {confirmKill.pid ?? "?"})? y/n</Text>}
      {filtering && <Text>filter: {filter}▏</Text>}
      <Text dimColor>{error ? `hub unreachable — reconnecting… (${error})` : FOOTER_HINT}</Text>
    </Box>
  );
}
