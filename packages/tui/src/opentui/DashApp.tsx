/** @jsxImportSource @opentui/react */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { ATTACH_PLACEMENTS, LIVE_STATUSES, TERMINAL_STATUSES, type SessionRow } from "@agmux/protocol";
import type { SessionFeed } from "../feed.ts";
import type { Actions, AttachRequest, Handoff, PreviewMode, PreviewSource, UsageSummary } from "../types.ts";
import { sortRows, nextSort, sortDirection, DEFAULT_SORT, type SortKey } from "../shared/sort.ts";
import { searchRows } from "../shared/search.ts";
import { groupRows, nextGroup, type ActivityGroup } from "../shared/group.ts";
import { yankFields } from "../shared/yank.ts";
import { attachKind, attachTargets, NO_ATTACH_CTX, type AttachCtx } from "../shared/attach-targets.ts";
import { COLUMNS, DEFAULT_COLUMNS, type ColumnKey } from "../shared/columns.ts";
import { SPINNER_MS } from "../shared/glyph.ts";
import { MOCHA } from "../shared/palette.ts";
import { matchAttachedPane } from "./attached.ts";
import { HeaderBar } from "./HeaderBar.tsx";
import { SessionTable } from "./SessionTable.tsx";
import { PreviewPane } from "./PreviewPane.tsx";
import { FooterBar } from "./FooterBar.tsx";
import { AttachOverlay, HelpOverlay, YankOverlay } from "./Overlays.tsx";

export interface DashAppProps {
  // A feed per activity group — each group has its own hub query, row cap and
  // poll cadence, so switching groups (key `f`) re-queries instead of just
  // re-filtering what the previous group happened to fetch. Called once per
  // subscription; return a fresh feed each time (feeds subscribe once).
  feedFor: (g: ActivityGroup) => SessionFeed;
  source: PreviewSource;
  actions: Actions;
  hubUrl: string;
  defaultPreview: PreviewMode;
  intervalMs: number;
  initialGroup?: ActivityGroup;
  onHandoff: (h: Handoff) => void;
  onQuit: () => void;
  // best-effort active pane id from the parent tmux client (Task 15); null when unknown
  activePane?: string | null;
  // tmux socket of the parent client; pane ids aren't unique across servers, so the
  // attached-pane match compares socket + pane. null = ambient/default server.
  activeSocket?: string | null;
  // Visible table columns, in order (`[dash] columns`). Default: DEFAULT_COLUMNS.
  columns?: ColumnKey[];
  // Show the column-title row (`[dash] header`). Default: off.
  showHeader?: boolean;
  // Spinner tick for running rows; 0 keeps it on its first frame. Default SPINNER_MS.
  spinnerMs?: number;
  // The caller's tmux/popup/terminal situation (cli attachCtxFor). Drives which
  // attach-popup targets are enabled. Default: outside tmux, no terminals.
  attachCtx?: AttachCtx;
}

// The dash has two preview tabs: mirror / detail.
const TABS: PreviewMode[] = ["mirror", "detail"];

// Panes have no borders; a faint vertical rule with whitespace either side
// separates the table from the preview.
const SEP_COLOR = MOCHA.surface1;
const SEP_PAD = 2;
const SEP_WIDTH = SEP_PAD * 2 + 1;
const PREVIEW_SHARE = 0.45;
// Horizontal padding of the table pane (left + right).
const TABLE_PAD = 2;

function sortLabel(k: SortKey): string {
  const name = k === "glyph" ? "status" : COLUMNS[k].header.toLowerCase();
  return `${name}${sortDirection(k) === "desc" ? "▾" : "▴"}`;
}

export function DashApp(props: DashAppProps) {
  const { feedFor, hubUrl } = props;

  const { width, height } = useTerminalDimensions();
  const columns = props.columns ?? DEFAULT_COLUMNS;

  const [group, setGroup] = useState<ActivityGroup>(props.initialGroup ?? "open");

  // Feed → rows via useSyncExternalStore (synchronous notify; same as Ink path).
  // `subscribe` changes identity with the group, so React tears the old feed
  // down and starts the new group's query; the previous rows stay on screen
  // until its first poll lands (immediate, so the gap is a frame or two).
  const snapRef = useRef<{ rows: SessionRow[] | null; error: string | null }>({ rows: null, error: null });
  const subscribe = useCallback(
    (notify: () => void) =>
      feedFor(group).subscribe(
        (r) => { snapRef.current = { rows: r, error: null }; notify(); },
        (e) => { snapRef.current = { ...snapRef.current, error: e.message }; notify(); },
      ),
    [feedFor, group],
  );
  const getSnap = useCallback(() => snapRef.current, []);
  const { rows, error } = useSyncExternalStore(subscribe, getSnap);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<PreviewMode>(props.defaultPreview);
  const [showPreview, setShowPreview] = useState(true);
  const [sortKey, setSortKey] = useState<SortKey>(DEFAULT_SORT);
  const [search, setSearch] = useState("");
  const [searching, setSearching] = useState(false);
  const [confirmKill, setConfirmKill] = useState<SessionRow | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [yankOpen, setYankOpen] = useState(false);
  const [yankCursor, setYankCursor] = useState(0);
  const [attachOpen, setAttachOpen] = useState(false);
  const [attachCursor, setAttachCursor] = useState(0);
  const attachCtx = props.attachCtx ?? NO_ATTACH_CTX;

  const visible = useMemo(
    () => sortRows(groupRows(searchRows(rows ?? [], search), group), sortKey),
    [rows, search, group, sortKey],
  );
  // Spinner frame for running rows — the timer only runs while something is running.
  const anyRunning = useMemo(() => (rows ?? []).some((r) => r.status === "running"), [rows]);
  const [frame, setFrame] = useState(0);
  const spinnerMs = props.spinnerMs ?? SPINNER_MS;
  useEffect(() => {
    if (!anyRunning || spinnerMs <= 0) return;
    const t = setInterval(() => setFrame((f) => f + 1), spinnerMs);
    return () => clearInterval(t);
  }, [anyRunning, spinnerMs]);

  const attachedId = useMemo(
    () => matchAttachedPane(visible, props.activePane ?? null, props.activeSocket ?? null),
    [visible, props.activePane, props.activeSocket],
  );

  const effectiveSelectedId =
    selectedId && visible.some((r) => r.session_id === selectedId)
      ? selectedId
      : (visible[0]?.session_id ?? null);
  const selected = visible.find((r) => r.session_id === effectiveSelectedId) ?? null;

  // Async-decoupled preview buffers — live, tagged by session_id.
  const [mirror, setMirror] = useState<{ id: string | null; text: string }>({ id: null, text: "" });
  const [usageBuf, setUsageBuf] = useState<{ id: string | null; data: UsageSummary | null }>({ id: null, data: null });

  const canMirror = (r: SessionRow | null) => !!r && LIVE_STATUSES.includes(r.status) && !!r.tmux_pane;
  // Mirror needs a live pane; otherwise fall back to the always-available detail tab.
  const effectiveMode: PreviewMode = mode === "mirror" && !canMirror(selected) ? "detail" : mode;

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

  const doYank = (i: number) => {
    if (!selected) return;
    const field = yankFields(selected)[i];
    setYankOpen(false);
    if (!field) return;
    if (field.empty) { setNotice(`${field.label} is empty`); return; }
    void props.actions
      .copy(field.value)
      // Best-effort on the OSC 52 fallback path: the write is fire-and-forget with
      // no terminal ack, so "copied" here just means the escape was sent, not confirmed.
      .then(() => setNotice(`copied ${field.label}`))
      .catch((e) => setNotice(`copy failed: ${e?.message ?? String(e)}`));
  };

  // Open a row: resume a closed session, attach a live one. No request = the
  // configured default (⏎); the attach popup passes an explicit placement.
  const openRow = (row: SessionRow, req?: AttachRequest) => {
    const closed = TERMINAL_STATUSES.includes(row.status);
    const run = closed ? props.actions.resume(row, req) : props.actions.attach(row, req);
    void run
      .then((h) => { if (h) { props.onHandoff(h); props.onQuit(); } })
      .catch((e) => setNotice(`${closed ? "resume" : "attach"} failed: ${e?.message ?? String(e)}`));
  };

  const doAttach = (i: number) => {
    if (!selected) return;
    const t = attachTargets(attachKind(selected), attachCtx)[i];
    setAttachOpen(false);
    if (!t) return;
    if (!t.enabled) { setNotice(`${t.label}: ${t.reason}`); return; }
    openRow(selected, { placement: t.placement });
  };

  useKeyboard((key) => {
    if (searching) {
      if (key.name === "return" || key.name === "escape") { setSearching(false); return; }
      if (key.name === "backspace") { setSearch((f) => f.slice(0, -1)); return; }
      if (key.sequence && key.sequence.length === 1 && !key.ctrl && !key.meta) setSearch((f) => f + key.sequence);
      return;
    }
    if (confirmKill) {
      if (key.name === "y") { void props.actions.kill(confirmKill); setConfirmKill(null); }
      else if (key.name === "n" || key.name === "escape") setConfirmKill(null);
      return;
    }
    if (showHelp) { if (key.name === "escape" || key.name === "q" || key.name === "?") setShowHelp(false); return; }

    if (yankOpen) {
      if (key.name === "escape" || key.name === "q" || key.name === "y") { setYankOpen(false); return; }
      if (key.name === "j" || key.name === "down") { setYankCursor((c) => Math.min(9, c + 1)); return; }
      if (key.name === "k" || key.name === "up") { setYankCursor((c) => Math.max(0, c - 1)); return; }
      if (key.name === "return") { doYank(yankCursor); return; }
      if (key.name && /^[0-9]$/.test(key.name)) { doYank(key.name === "0" ? 9 : Number(key.name) - 1); return; }
      return;
    }

    if (attachOpen) {
      const last = ATTACH_PLACEMENTS.length - 1;
      if (key.name === "escape" || key.name === "q" || (key.name === "a" && key.shift)) { setAttachOpen(false); return; }
      if (key.name === "j" || key.name === "down") { setAttachCursor((c) => Math.min(last, c + 1)); return; }
      if (key.name === "k" || key.name === "up") { setAttachCursor((c) => Math.max(0, c - 1)); return; }
      if (key.name === "return") { doAttach(attachCursor); return; }
      if (key.name && /^[1-9]$/.test(key.name) && Number(key.name) <= last + 1) { doAttach(Number(key.name) - 1); return; }
      return;
    }

    // Any key dismisses a lingering notice (a failed attach/resume message).
    if (notice) setNotice(null);

    if (key.name === "q") { props.onQuit(); return; }
    if (key.name === "?") { setShowHelp(true); return; }
    if (key.name === "y" && selected) { setYankCursor(0); setYankOpen(true); return; }
    // OpenTUI reports a shifted letter as its lowercase name + shift.
    if (key.name === "a" && key.shift && selected) { setAttachCursor(0); setAttachOpen(true); return; }
    if (key.name === "j" || key.name === "down") { move(1); return; }
    if (key.name === "k" || key.name === "up") { move(-1); return; }
    if (key.name === "g") { setSelectedId(visible[0]?.session_id ?? null); return; }
    if (key.name === "G") { setSelectedId(visible[visible.length - 1]?.session_id ?? null); return; }
    if (key.name === "s") { setSortKey((k) => nextSort(k, columns)); return; }
    if (key.name === "f") { setGroup((g) => nextGroup(g)); return; }
    if (key.name === "p") { setShowPreview((v) => !v); return; }
    if (key.name === "tab") { setMode((m) => TABS[(TABS.indexOf(m) + 1) % TABS.length]!); return; }
    if (key.name === "/") { setSearch(""); setSearching(true); return; }
    if (key.name === "return" && selected) { openRow(selected); return; }
    if (key.name === "x" && selected && LIVE_STATUSES.includes(selected.status)) { setConfirmKill(selected); return; }
    // Mark the highlighted row seen (dismiss). One-way: there is no backing
    // "mark unread" event, so this only ever moves a row from unread → read
    // (see dash-actions.markSeen).
    if (key.name === "u" && selected) { void props.actions.markSeen(selected).catch(() => {}); return; }
  });

  const now = Date.now();
  // Body height budget: total minus header(1) + its spacer(1) + footer spacer(1) + footer(1).
  const bodyHeight = Math.max(3, height - 4);
  const previewWidth = Math.floor(width * PREVIEW_SHARE);
  const tableWidth = width - TABLE_PAD - (showPreview ? previewWidth + SEP_WIDTH : 0);

  if (showHelp) return <HelpOverlay frame={frame} />;
  if (yankOpen && selected) {
    return <YankOverlay row={selected} fields={yankFields(selected)} cursor={yankCursor} screenWidth={width} />;
  }
  if (attachOpen && selected) {
    return <AttachOverlay row={selected} targets={attachTargets(attachKind(selected), attachCtx)} cursor={attachCursor} screenWidth={width} />;
  }

  return (
    <box style={{ flexDirection: "column", width: "100%", height: "100%" }}>
      <HeaderBar rows={rows ?? []} connected={!error} hubUrl={hubUrl} group={group} frame={frame} />
      <text> </text>
      <box style={{ flexDirection: "row", flexGrow: 1, minHeight: 0 }}>
        <box style={{ flexGrow: 1, minHeight: 0, paddingLeft: 1, paddingRight: 1 }}>
          {rows === null
            ? <text fg={MOCHA.overlay0}>connecting to {hubUrl}…</text>
            : <SessionTable
                rows={visible} selectedId={effectiveSelectedId} attachedId={attachedId} now={now}
                columns={columns} showHeader={props.showHeader ?? false} width={tableWidth} height={bodyHeight} frame={frame}
                sortKey={sortKey} onSelect={setSelectedId}
              />}
        </box>
        {showPreview && (
          <box style={{ width: SEP_WIDTH, minHeight: 0, paddingLeft: SEP_PAD, paddingRight: SEP_PAD }}>
            <box style={{ flexGrow: 1, border: ["left"], borderColor: SEP_COLOR }} />
          </box>
        )}
        {showPreview && (
          <box style={{ width: previewWidth, minHeight: 0, paddingRight: 1 }}>
            <PreviewPane
              row={selected} mode={effectiveMode}
              mirrorText={mirror.id === effectiveSelectedId ? mirror.text : ""}
              usage={usageBuf.id === effectiveSelectedId ? usageBuf.data : null}
              viewportHeight={bodyHeight - 2}
            />
          </box>
        )}
      </box>
      <text> </text>
      <box style={{ height: 1, paddingLeft: 1, paddingRight: 1 }}>
        <FooterBar
          error={error} searching={searching} search={search}
          confirmKill={confirmKill?.session_id.slice(0, 13) ?? null} notice={notice}
          sortLabel={sortLabel(sortKey)}
          width={width - 2}
        />
      </box>
    </box>
  );
}
