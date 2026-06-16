# agmux dash — TUI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an `agmux dash` verb: a lazygit-style interactive TUI with a grouped session table on the left and a toggleable (mirror / events / detail) preview on the right, with attach / kill / resume actions.

**Architecture:** New verb beside `watch`. The `@agmux/tui` package stays pure (depends only on `@agmux/protocol`) — all tmux/process/HTTP side-effects are injected from `@agmux/cli` via two interfaces (`PreviewSource`, `Actions`). Pure formatters and React components are unit-tested; the CLI wires concrete implementations that reuse existing `attach.ts`/`kill.ts`/`relaunch.ts` and `tmux capture-pane`.

**Tech Stack:** Bun + TypeScript (ESNext, `.ts`/`.tsx`), ink 7 + React 19, `bun:test`, `ink-testing-library`, `smol-toml`.

**Spec:** `docs/superpowers/specs/2026-06-15-agmux-dash-tui-design.md`

---

## File structure

**New — `packages/tui/src/`**
- `types.ts` — `PreviewMode`, `UsageSummary`, `Handoff`, `PreviewSource`, `Actions` interfaces.
- `group-table.ts` — pure grouping + table formatting + filter/navigation helpers.
- `detail.ts` — pure `detailLines(row, usage)`.
- `events-format.ts` — pure `eventLines(events)`.
- `keymap.ts` — footer + help text constants.
- `session-list.tsx` — grouped table component with selection highlight.
- `preview.tsx` — preview pane (tabs + body) component.
- `manage-app.tsx` — the shell component (state, keymap, preview polling, actions, modal).
- `run-manage.tsx` — entry: alt-screen, render, post-exit handoff.

**Modified — `packages/tui/src/`**
- `format.ts` — export the existing private `short()` for reuse.
- `index.ts` — export the new public surface.

**New — `packages/cli/src/`**
- `dash-preview.ts` — concrete `PreviewSource` (`capture-pane` + `/events` + `/sessions/:id` usage).
- `dash-actions.ts` — concrete `Actions` (reuse `buildAttachCommands` / `process.kill` / `buildRelaunchSpec`).
- `parse-dash.ts` — arg parsing (ls flags + `-i/--interval` + `--preview`).
- `dash.ts` — `dashCmd` (TTY guard, wire deps, call `runManage`).

**Modified**
- `packages/wrapper/src/profile.ts` + `index.ts` — `DashConfig`, `parseDashSection`, `loadDashConfig`.
- `packages/cli/bin/agmux.ts` — `case "dash"` + usage line.

**New tests**
- `packages/tui/tests/group-table.test.ts`, `detail.test.ts`, `events-format.test.ts`, `manage-app.test.tsx`
- `packages/cli/tests/dash-preview.test.ts`, `parse-dash.test.ts`, `dash.test.ts`
- `packages/wrapper/tests/dash-config.test.ts`

---

## Task 1: Export `short()` from format.ts

**Files:**
- Modify: `packages/tui/src/format.ts:43-46`

- [ ] **Step 1: Make `short` exported**

In `packages/tui/src/format.ts`, change the final function from `function short` to `export function short`:

```ts
export function short(iso: string): string {
  // 2026-05-28T12:00:00.000Z → 05-28 12:00
  return iso.slice(5, 16).replace("T", " ");
}
```

- [ ] **Step 2: Verify existing tests still pass**

Run: `cd packages/tui && bun test format.test.ts`
Expected: PASS (no behavior change).

- [ ] **Step 3: Commit**

```bash
git add packages/tui/src/format.ts
git commit -m "tui: export short() for reuse"
```

---

## Task 2: tui shared types

**Files:**
- Create: `packages/tui/src/types.ts`

- [ ] **Step 1: Write the types module**

```ts
import type { SessionRow, EventEnvelope } from "@agmux/protocol";

export type PreviewMode = "mirror" | "events" | "detail";

// Minimal usage shape the detail card needs; the cli maps the hub's usage row
// into this so tui stays free of @agmux/store types.
export interface UsageSummary {
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  last_model: string | null;
  turn_count: number;
}

// A terminal hand-off: a command the entry point runs AFTER ink unmounts and the
// alt-screen is restored (for not-in-tmux attach and for resume/relaunch).
export interface Handoff {
  argv: string[];
  env?: Record<string, string>;
}

// Side-effecting preview data sources; concrete impls live in cli.
export interface PreviewSource {
  mirror(row: SessionRow): Promise<string>;       // tmux capture-pane text ("" if unavailable)
  events(row: SessionRow): Promise<EventEnvelope[]>;
  usage(row: SessionRow): Promise<UsageSummary | null>;
}

// Mutating actions; concrete impls live in cli (reuse attach/kill/relaunch).
// attach/resume return a Handoff when the terminal must be handed off, or null
// when handled inline (e.g. in-tmux switch-client — the TUI stays alive).
export interface Actions {
  attach(row: SessionRow): Promise<Handoff | null>;
  kill(row: SessionRow): Promise<void>;
  resume(row: SessionRow): Promise<Handoff>;
}
```

- [ ] **Step 2: Typecheck**

Run: `cd packages/tui && bun run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/tui/src/types.ts
git commit -m "tui: dash preview/actions interfaces"
```

---

## Task 3: group-table formatter (pure)

**Files:**
- Create: `packages/tui/src/group-table.ts`
- Test: `packages/tui/tests/group-table.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect } from "bun:test";
import type { SessionRow, SessionStatus } from "@agmux/protocol";
import {
  groupSessions, buildDashTable, selectableRows, matchesFilter, dashActivityCell, DASH_HEADER,
} from "../src/group-table.ts";

function mkRow(over: Partial<SessionRow> = {}): SessionRow {
  return {
    session_id: "aaaaaaaa-1", agent_kind: "claude", profile: null, native_session_id: null,
    command: "claude", args: [], env_overrides: {}, cwd: "/tmp", pid: 1,
    tmux_session: null, tmux_window: null, tmux_pane: null, host: "h", project: null,
    parent_session_id: null, start_ts: "2026-06-11T10:00:00.000Z", last_heartbeat_ts: null,
    end_ts: null, exit_code: null, signal: null, status: "running", origin: "native",
    turn_count: null, last_tool: null, last_tool_detail: null, last_input_kind: null,
    activity_ts: null, ...over,
  };
}

test("groups appear in fixed order, empty groups dropped", () => {
  const rows = [
    mkRow({ session_id: "idle1", status: "idle" }),
    mkRow({ session_id: "wait1", status: "waiting" }),
    mkRow({ session_id: "run1", status: "running" }),
  ];
  expect(groupSessions(rows).map((g) => g.key)).toEqual(["waiting", "running", "idle"]);
});

test("dashActivityCell shows exit info for closed rows", () => {
  expect(dashActivityCell(mkRow({ status: "ended", exit_code: 0 }))).toBe("exited 0");
  expect(dashActivityCell(mkRow({ status: "ended", signal: "SIGTERM", exit_code: null }))).toBe("signal SIGTERM");
  expect(dashActivityCell(mkRow({ status: "lost" }))).toBe("lost");
  expect(dashActivityCell(mkRow({ status: "running", last_tool: "Edit" }))).toBe("tool: Edit");
});

test("buildDashTable aligns columns across all groups and labels each group", () => {
  const t = buildDashTable([
    mkRow({ session_id: "wait1", status: "waiting", last_input_kind: "permission" }),
    mkRow({ session_id: "run1", status: "running", last_tool: "Edit" }),
  ]);
  expect(t.header.startsWith("ID")).toBe(true);
  expect(t.groups[0]!.label).toBe("NEEDS INPUT");
  expect(t.groups[0]!.count).toBe(1);
  // every row line is the same width as the header (column alignment)
  for (const g of t.groups) for (const r of g.rows) expect(r.text.length).toBe(t.header.length);
});

test("buildDashTable on empty rows yields header from labels only", () => {
  const t = buildDashTable([]);
  expect(t.groups).toEqual([]);
  expect(t.header.split(/\s{2,}/)).toEqual([...DASH_HEADER]);
});

test("selectableRows is the flat ordered row list (no headers)", () => {
  const rows = [mkRow({ session_id: "a", status: "idle" }), mkRow({ session_id: "b", status: "waiting" })];
  expect(selectableRows(rows).map((r) => r.session_id)).toEqual(["b", "a"]);
});

test("matchesFilter matches id/agent/profile/activity case-insensitively", () => {
  const r = mkRow({ session_id: "deadbeef", profile: "infra", status: "running", last_tool: "Bash" });
  expect(matchesFilter(r, "DEAD")).toBe(true);
  expect(matchesFilter(r, "infra")).toBe(true);
  expect(matchesFilter(r, "bash")).toBe(true);
  expect(matchesFilter(r, "codex")).toBe(false);
  expect(matchesFilter(r, "")).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/tui && bun test group-table.test.ts`
Expected: FAIL with "Cannot find module '../src/group-table.ts'".

- [ ] **Step 3: Write the implementation**

```ts
import type { SessionRow, SessionStatus } from "@agmux/protocol";
import { activityCell, short } from "./format.ts";

export type GroupKey = "waiting" | "running" | "idle" | "closed";

interface GroupDef { key: GroupKey; label: string; statuses: SessionStatus[]; }

// Fixed display order — needs-input first (spec §4).
const GROUP_DEFS: GroupDef[] = [
  { key: "waiting", label: "NEEDS INPUT", statuses: ["waiting"] },
  { key: "running", label: "WORKING", statuses: ["running"] },
  { key: "idle", label: "IDLE", statuses: ["idle"] },
  { key: "closed", label: "CLOSED", statuses: ["ended", "lost"] },
];

export const DASH_HEADER = ["ID", "AGENT", "PROFILE", "ACTIVITY", "TURNS", "LAST"] as const;

// Activity text for the dash table: reuse activityCell for live rows; closed
// rows show how they ended instead of "-".
export function dashActivityCell(r: SessionRow): string {
  if (r.status === "ended") return r.signal ? `signal ${r.signal}` : `exited ${r.exit_code ?? "?"}`;
  if (r.status === "lost") return "lost";
  return activityCell(r);
}

function cells(r: SessionRow): string[] {
  return [
    r.session_id.slice(0, 8),
    r.agent_kind,
    r.profile ?? "-",
    dashActivityCell(r),
    r.turn_count == null ? "-" : String(r.turn_count),
    short(r.last_heartbeat_ts ?? r.start_ts),
  ];
}

export function groupSessions(rows: SessionRow[]): { key: GroupKey; label: string; rows: SessionRow[] }[] {
  return GROUP_DEFS
    .map((d) => ({ key: d.key, label: d.label, rows: rows.filter((r) => d.statuses.includes(r.status)) }))
    .filter((g) => g.rows.length > 0);
}

export interface DashRow { row: SessionRow; text: string; }
export interface DashGroup { key: GroupKey; label: string; count: number; rows: DashRow[]; }
export interface DashTable { header: string; groups: DashGroup[]; }

export function buildDashTable(rows: SessionRow[]): DashTable {
  const groups = groupSessions(rows);
  const all = groups.flatMap((g) => g.rows);
  const cellMap = new Map<string, string[]>();
  for (const r of all) cellMap.set(r.session_id, cells(r));
  const widths = DASH_HEADER.map((h, i) =>
    all.length ? Math.max(h.length, ...all.map((r) => cellMap.get(r.session_id)![i]!.length)) : h.length,
  );
  const fmt = (c: readonly string[]) => c.map((x, i) => x.padEnd(widths[i]!)).join("  ");
  return {
    header: fmt(DASH_HEADER),
    groups: groups.map((g) => ({
      key: g.key, label: g.label, count: g.rows.length,
      rows: g.rows.map((r) => ({ row: r, text: fmt(cellMap.get(r.session_id)!) })),
    })),
  };
}

// Flat selectable order in group order — drives j/k navigation.
export function selectableRows(rows: SessionRow[]): SessionRow[] {
  return groupSessions(rows).flatMap((g) => g.rows);
}

export function matchesFilter(r: SessionRow, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  return [r.session_id, r.agent_kind, r.profile ?? "", dashActivityCell(r)]
    .some((s) => s.toLowerCase().includes(needle));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/tui && bun test group-table.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/tui/src/group-table.ts packages/tui/tests/group-table.test.ts
git commit -m "tui: dash grouped-table formatter + nav/filter helpers"
```

---

## Task 4: detail formatter (pure)

**Files:**
- Create: `packages/tui/src/detail.ts`
- Test: `packages/tui/tests/detail.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect } from "bun:test";
import type { SessionRow } from "@agmux/protocol";
import { detailLines } from "../src/detail.ts";

function mkRow(over: Partial<SessionRow> = {}): SessionRow {
  return {
    session_id: "aaaa", agent_kind: "claude", profile: "main", native_session_id: null,
    command: "claude", args: ["--foo"], env_overrides: {}, cwd: "/tmp", pid: 42,
    tmux_session: "agmux", tmux_window: "@3", tmux_pane: "%9", host: "h", project: "agmux",
    parent_session_id: null, start_ts: "2026-06-11T10:00:00.000Z", last_heartbeat_ts: "2026-06-11T10:05:00.000Z",
    end_ts: null, exit_code: null, signal: null, status: "running", origin: "native",
    turn_count: 4, last_tool: null, last_tool_detail: null, last_input_kind: null, activity_ts: null, ...over,
  };
}

test("detailLines renders core fields and tmux coords", () => {
  const lines = detailLines(mkRow(), null);
  expect(lines).toContain("status   running");
  expect(lines).toContain("agent    claude (main)");
  expect(lines).toContain("project  agmux");
  expect(lines).toContain("command  claude --foo");
  expect(lines).toContain("tmux     agmux:@3.%9");
});

test("detailLines appends usage when present", () => {
  const lines = detailLines(mkRow(), {
    input_tokens: 1200, output_tokens: 800, cost_usd: 0.84, last_model: "sonnet-4-6", turn_count: 4,
  });
  expect(lines).toContain("tokens   in 1200 · out 800");
  expect(lines).toContain("model    sonnet-4-6");
  expect(lines).toContain("cost     $0.84");
});

test("detailLines omits usage block when null", () => {
  expect(detailLines(mkRow(), null).some((l) => l.startsWith("tokens"))).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/tui && bun test detail.test.ts`
Expected: FAIL with "Cannot find module '../src/detail.ts'".

- [ ] **Step 3: Write the implementation**

```ts
import type { SessionRow } from "@agmux/protocol";
import type { UsageSummary } from "./types.ts";

// Lines for the "detail" preview tab. Pure: data comes from the row + optional usage.
export function detailLines(row: SessionRow, usage: UsageSummary | null): string[] {
  const tmux = row.tmux_session && row.tmux_window
    ? `${row.tmux_session}:${row.tmux_window}${row.tmux_pane ? `.${row.tmux_pane}` : ""}`
    : "-";
  const lines = [
    `status   ${row.status}`,
    `agent    ${row.agent_kind}${row.profile ? ` (${row.profile})` : ""}`,
    `project  ${row.project ?? "-"}`,
    `command  ${[row.command, ...row.args].join(" ")}`,
    `pid      ${row.pid ?? "-"}`,
    `tmux     ${tmux}`,
    `turns    ${row.turn_count ?? "-"}`,
    `started  ${row.start_ts}`,
    `last     ${row.last_heartbeat_ts ?? "-"}`,
  ];
  if (usage) {
    lines.push(
      `tokens   in ${usage.input_tokens} · out ${usage.output_tokens}`,
      `model    ${usage.last_model ?? "-"}`,
      `cost     $${usage.cost_usd.toFixed(2)}`,
    );
  }
  return lines;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/tui && bun test detail.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/tui/src/detail.ts packages/tui/tests/detail.test.ts
git commit -m "tui: dash detail formatter"
```

---

## Task 5: events formatter (pure)

**Files:**
- Create: `packages/tui/src/events-format.ts`
- Test: `packages/tui/tests/events-format.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect } from "bun:test";
import type { EventEnvelope } from "@agmux/protocol";
import { eventLines } from "../src/events-format.ts";

function ev(kind: string, payload: unknown, ts = "2026-06-11T12:05:11.000Z"): EventEnvelope {
  return { event_id: "01", ts, session_id: "s", kind, version: 1, host: "h", payload };
}

test("eventLines renders HH:MM:SS + kind", () => {
  expect(eventLines([ev("turn.started", {})])).toEqual(["12:05:11 turn.started"]);
});

test("eventLines summarizes tool.used and input.required", () => {
  expect(eventLines([ev("tool.used", { tool: "Edit", detail: "a.ts" })])).toEqual(["12:05:11 tool.used Edit a.ts"]);
  expect(eventLines([ev("input.required", { kind: "permission" })])).toEqual(["12:05:11 input.required permission"]);
});

test("eventLines tolerates null/odd payloads", () => {
  expect(eventLines([ev("session.heartbeat", null)])).toEqual(["12:05:11 session.heartbeat"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/tui && bun test events-format.test.ts`
Expected: FAIL with "Cannot find module '../src/events-format.ts'".

- [ ] **Step 3: Write the implementation**

```ts
import type { EventEnvelope } from "@agmux/protocol";

// One line per event for the "events" preview tab: HH:MM:SS kind [summary].
export function eventLines(events: EventEnvelope[]): string[] {
  return events.map((e) => `${e.ts.slice(11, 19)} ${e.kind}${summarize(e)}`);
}

function summarize(e: EventEnvelope): string {
  const p = e.payload as Record<string, unknown> | null;
  if (!p || typeof p !== "object") return "";
  if (e.kind === "tool.used" && typeof p.tool === "string")
    return ` ${p.tool}${typeof p.detail === "string" ? ` ${p.detail}` : ""}`;
  if (e.kind === "input.required" && typeof p.kind === "string") return ` ${p.kind}`;
  return "";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/tui && bun test events-format.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/tui/src/events-format.ts packages/tui/tests/events-format.test.ts
git commit -m "tui: dash events formatter"
```

---

## Task 6: keymap constants

**Files:**
- Create: `packages/tui/src/keymap.ts`

- [ ] **Step 1: Write the module**

```ts
export const FOOTER_HINT =
  "j/k row  { } group  < > resize  tab preview  ⏎ attach  x kill  r resume  / filter  ? help  q quit";

export const HELP_LINES = [
  "j / k        move selection down / up",
  "{ / }        jump to previous / next group",
  "< / >        shrink / grow the table split",
  "tab          cycle preview: mirror → events → detail",
  "enter        attach to the selected session",
  "x            kill the selected live session (confirm)",
  "r            resume/relaunch the selected closed session",
  "/            filter by id/agent/profile/activity (enter/esc to apply)",
  "?            toggle this help",
  "q            quit",
];
```

- [ ] **Step 2: Typecheck**

Run: `cd packages/tui && bun run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/tui/src/keymap.ts
git commit -m "tui: dash keymap/help text"
```

---

## Task 7: SessionList component

**Files:**
- Create: `packages/tui/src/session-list.tsx`

(No standalone test — it is exercised by the ManageApp tests in Task 10.)

- [ ] **Step 1: Write the component**

```tsx
import React from "react";
import { Box, Text } from "ink";
import type { SessionRow } from "@agmux/protocol";
import { buildDashTable } from "./group-table.ts";

export function SessionList({ rows, selectedId }: { rows: SessionRow[]; selectedId: string | null }) {
  const table = buildDashTable(rows);
  return (
    <Box flexDirection="column">
      <Text dimColor>{"  " + table.header}</Text>
      {table.groups.map((g) => (
        <Box key={g.key} flexDirection="column">
          <Text color="yellow">{`${g.label} (${g.count})`}</Text>
          {g.rows.map((dr) => {
            const sel = dr.row.session_id === selectedId;
            return (
              <Text key={dr.row.session_id} inverse={sel}>
                {(sel ? "› " : "  ") + dr.text}
              </Text>
            );
          })}
        </Box>
      ))}
    </Box>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `cd packages/tui && bun run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/tui/src/session-list.tsx
git commit -m "tui: dash session list component"
```

---

## Task 8: Preview component

**Files:**
- Create: `packages/tui/src/preview.tsx`

(No standalone test — exercised by ManageApp tests in Task 10.)

- [ ] **Step 1: Write the component**

```tsx
import React from "react";
import { Box, Text } from "ink";
import type { SessionRow, EventEnvelope } from "@agmux/protocol";
import type { PreviewMode, UsageSummary } from "./types.ts";
import { detailLines } from "./detail.ts";
import { eventLines } from "./events-format.ts";

export interface PreviewProps {
  row: SessionRow | null;
  mode: PreviewMode;          // already resolved (caller applies mirror→events fallback)
  mirrorText: string;
  events: EventEnvelope[];
  usage: UsageSummary | null;
}

const MODES: PreviewMode[] = ["mirror", "events", "detail"];

export function Preview({ row, mode, mirrorText, events, usage }: PreviewProps) {
  const tabs = MODES.map((m) => (m === mode ? `[${m}]` : ` ${m} `)).join(" ");
  return (
    <Box flexDirection="column">
      <Text>{tabs}</Text>
      <Text dimColor>{"─".repeat(40)}</Text>
      {row === null ? <Text dimColor>no session selected</Text> : <Body row={row} mode={mode} mirrorText={mirrorText} events={events} usage={usage} />}
    </Box>
  );
}

function Body({ row, mode, mirrorText, events, usage }: { row: SessionRow } & Omit<PreviewProps, "row">) {
  if (mode === "detail") return <Text>{detailLines(row, usage).join("\n")}</Text>;
  if (mode === "events") {
    const lines = eventLines(events);
    return <Text>{lines.length ? lines.join("\n") : "no events"}</Text>;
  }
  return <Text>{mirrorText || "…"}</Text>;
}
```

- [ ] **Step 2: Typecheck**

Run: `cd packages/tui && bun run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/tui/src/preview.tsx
git commit -m "tui: dash preview component"
```

---

## Task 9: ManageApp shell component

**Files:**
- Create: `packages/tui/src/manage-app.tsx`

- [ ] **Step 1: Write the component**

```tsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
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

  const [rows, setRows] = useState<SessionRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
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

  useEffect(() => feed.subscribe(
    (r) => { setRows(r); setError(null); },
    (e) => setError(e.message),
  ), [feed]);

  const visible = useMemo(() => (rows ?? []).filter((r) => matchesFilter(r, filter)), [rows, filter]);
  const flat = useMemo(() => selectableRows(visible), [visible]);

  // Keep selection valid as rows change; default to first selectable row.
  useEffect(() => {
    if (flat.length === 0) { setSelectedId(null); return; }
    if (!selectedId || !flat.some((r) => r.session_id === selectedId)) setSelectedId(flat[0]!.session_id);
  }, [flat, selectedId]);

  const selected = flat.find((r) => r.session_id === selectedId) ?? null;
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
  }, [selectedId, effectiveMode, intervalMs, source]);

  const move = (delta: number) => {
    if (flat.length === 0) return;
    const i = Math.max(0, flat.findIndex((r) => r.session_id === selectedId));
    const next = Math.min(flat.length - 1, Math.max(0, i + delta));
    setSelectedId(flat[next]!.session_id);
  };
  const jumpGroup = (delta: number) => {
    const groups = groupSessions(visible);
    const firsts = groups.map((g) => g.rows[0]!.session_id);
    const cur = groups.findIndex((g) => g.rows.some((r) => r.session_id === selectedId));
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
  return (
    <Box flexDirection="column">
      <Box>
        <Box width={leftPct} flexDirection="column">
          {rows === null
            ? <Text dimColor>connecting to {hubUrl}…</Text>
            : <SessionList rows={visible} selectedId={selectedId} />}
        </Box>
        <Box width={rightPct} flexDirection="column" marginLeft={1}>
          <Preview row={selected} mode={effectiveMode} mirrorText={mirrorText} events={events} usage={usage} />
        </Box>
      </Box>
      {confirmKill && <Text color="red">kill {confirmKill.session_id.slice(0, 8)} (pid {confirmKill.pid ?? "?"})? y/n</Text>}
      {filtering && <Text>filter: {filter}▏</Text>}
      <Text dimColor>{error ? `hub unreachable — reconnecting… (${error})` : FOOTER_HINT}</Text>
    </Box>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `cd packages/tui && bun run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/tui/src/manage-app.tsx
git commit -m "tui: dash ManageApp shell"
```

---

## Task 10: ManageApp behavior tests

**Files:**
- Test: `packages/tui/tests/manage-app.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
import { test, expect } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import type { SessionRow } from "@agmux/protocol";
import type { SessionFeed } from "../src/feed.ts";
import type { Actions, Handoff, PreviewSource } from "../src/types.ts";
import { ManageApp } from "../src/manage-app.tsx";

function mkRow(over: Partial<SessionRow> = {}): SessionRow {
  return {
    session_id: "aaaaaaaa", agent_kind: "claude", profile: null, native_session_id: null,
    command: "claude", args: [], env_overrides: {}, cwd: "/tmp", pid: 1,
    tmux_session: "agmux", tmux_window: "@1", tmux_pane: "%1", host: "h", project: null,
    parent_session_id: null, start_ts: "2026-06-11T10:00:00.000Z", last_heartbeat_ts: null,
    end_ts: null, exit_code: null, signal: null, status: "running", origin: "native",
    turn_count: 1, last_tool: "Edit", last_tool_detail: null, last_input_kind: null, activity_ts: null, ...over,
  };
}

function manualFeed() {
  let update: (rows: SessionRow[]) => void = () => {};
  const feed: SessionFeed = { subscribe(onUpdate) { update = onUpdate; return () => {}; } };
  return { feed, push: (r: SessionRow[]) => update(r) };
}

const noopSource: PreviewSource = {
  async mirror() { return "PANE OUTPUT"; },
  async events() { return []; },
  async usage() { return null; },
};
function recordingActions() {
  const calls: string[] = [];
  const actions: Actions = {
    async attach(r) { calls.push(`attach:${r.session_id}`); return null; },
    async kill(r) { calls.push(`kill:${r.session_id}`); },
    async resume(r): Promise<Handoff> { calls.push(`resume:${r.session_id}`); return { argv: ["x"] }; },
  };
  return { actions, calls };
}

const base = {
  source: noopSource, hubUrl: "http://h", defaultPreview: "detail" as const, intervalMs: 100000,
  onHandoff: () => {},
  setIntervalImpl: (() => 0 as unknown as ReturnType<typeof setInterval>) as typeof setInterval,
  clearIntervalImpl: (() => {}) as typeof clearInterval,
};

test("renders grouped table with group headers and selects first row", async () => {
  const m = manualFeed();
  const { actions } = recordingActions();
  const { lastFrame } = render(<ManageApp feed={m.feed} actions={actions} {...base} />);
  m.push([mkRow({ session_id: "run1", status: "running" }), mkRow({ session_id: "wait1", status: "waiting", last_input_kind: "permission" })]);
  await Bun.sleep(0);
  expect(lastFrame()).toContain("NEEDS INPUT (1)");
  expect(lastFrame()).toContain("WORKING (1)");
  expect(lastFrame()).toContain("› wait1");   // first selectable row (waiting group first)
});

test("j moves selection down across groups", async () => {
  const m = manualFeed();
  const { actions } = recordingActions();
  const { lastFrame, stdin } = render(<ManageApp feed={m.feed} actions={actions} {...base} />);
  m.push([mkRow({ session_id: "wait1", status: "waiting" }), mkRow({ session_id: "run1", status: "running" })]);
  await Bun.sleep(0);
  stdin.write("j");
  await Bun.sleep(0);
  expect(lastFrame()).toContain("› run1");
});

test("tab cycles preview mode label", async () => {
  const m = manualFeed();
  const { actions } = recordingActions();
  const { lastFrame, stdin } = render(<ManageApp feed={m.feed} actions={actions} {...base} />);
  m.push([mkRow({ session_id: "run1", status: "running" })]);
  await Bun.sleep(0);
  expect(lastFrame()).toContain("[detail]");
  stdin.write("\t");
  await Bun.sleep(0);
  expect(lastFrame()).toContain("[mirror]");
});

test("enter triggers attach", async () => {
  const m = manualFeed();
  const { actions, calls } = recordingActions();
  const { stdin } = render(<ManageApp feed={m.feed} actions={actions} {...base} />);
  m.push([mkRow({ session_id: "run1", status: "running" })]);
  await Bun.sleep(0);
  stdin.write("\r");
  await Bun.sleep(0);
  expect(calls).toContain("attach:run1");
});

test("x prompts confirm, y kills", async () => {
  const m = manualFeed();
  const { actions, calls } = recordingActions();
  const { lastFrame, stdin } = render(<ManageApp feed={m.feed} actions={actions} {...base} />);
  m.push([mkRow({ session_id: "run1", status: "running" })]);
  await Bun.sleep(0);
  stdin.write("x");
  await Bun.sleep(0);
  expect(lastFrame()).toContain("kill run1");
  stdin.write("y");
  await Bun.sleep(0);
  expect(calls).toContain("kill:run1");
});

test("mirror mode falls back to events for a dead session", async () => {
  const m = manualFeed();
  const { actions } = recordingActions();
  const { lastFrame, stdin } = render(<ManageApp feed={m.feed} actions={actions} {...base} />);
  m.push([mkRow({ session_id: "dead1", status: "ended", exit_code: 0, tmux_pane: null })]);
  await Bun.sleep(0);
  stdin.write("\t"); // detail → mirror
  await Bun.sleep(0);
  expect(lastFrame()).toContain("[events]"); // resolved away from mirror
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/tui && bun test manage-app.test.tsx`
Expected: FAIL (component import resolves, but assertions fail / earlier tasks must be present). If Task 9 is committed, this should drive only assertion-level fixes.

- [ ] **Step 3: Make tests pass**

The implementation in Task 9 should satisfy these. If any assertion fails, fix `manage-app.tsx` (not the test) until green.

- [ ] **Step 4: Run the whole tui suite**

Run: `cd packages/tui && bun test`
Expected: PASS (all files).

- [ ] **Step 5: Commit**

```bash
git add packages/tui/tests/manage-app.test.tsx
git commit -m "tui: dash ManageApp behavior tests"
```

---

## Task 11: run-manage entry + index exports

**Files:**
- Create: `packages/tui/src/run-manage.tsx`
- Modify: `packages/tui/src/index.ts`

- [ ] **Step 1: Write the entry point**

```tsx
import React from "react";
import { render } from "ink";
import { PollingSessionFeed } from "./feed.ts";
import { ManageApp } from "./manage-app.tsx";
import type { Actions, Handoff, PreviewMode, PreviewSource } from "./types.ts";

export interface RunManageOpts {
  hubUrl: string;
  query: URLSearchParams;
  intervalMs: number;
  defaultPreview: PreviewMode;
  source: PreviewSource;
  actions: Actions;
}

export async function runManage(o: RunManageOpts): Promise<number> {
  const feed = new PollingSessionFeed({ hubUrl: o.hubUrl, query: o.query, intervalMs: o.intervalMs });
  let pending: Handoff | null = null;
  process.stdout.write("\x1b[?1049h\x1b[H"); // enter alt screen, home cursor
  try {
    const app = render(
      <ManageApp
        feed={feed} source={o.source} actions={o.actions} hubUrl={o.hubUrl}
        defaultPreview={o.defaultPreview} intervalMs={o.intervalMs}
        onHandoff={(h) => { pending = h; }}
      />,
      { exitOnCtrlC: true },
    );
    await app.waitUntilExit();
  } finally {
    process.stdout.write("\x1b[?1049l"); // restore the user's screen even on throw
  }
  if (pending) {
    const h: Handoff = pending;
    const child = Bun.spawn(h.argv, { stdio: ["inherit", "inherit", "inherit"], env: h.env ?? process.env });
    await child.exited;
    return child.exitCode ?? 0;
  }
  return 0;
}
```

- [ ] **Step 2: Extend index.ts exports**

Replace `packages/tui/src/index.ts` with:

```ts
export { formatTable, activityCell, short } from "./format.ts";
export { PollingSessionFeed, type SessionFeed, type PollingFeedOpts } from "./feed.ts";
export { runWatch, type RunWatchOpts } from "./run-watch.tsx";
export { runManage, type RunManageOpts } from "./run-manage.tsx";
export { ManageApp, type ManageAppProps } from "./manage-app.tsx";
export {
  type PreviewMode, type UsageSummary, type Handoff, type PreviewSource, type Actions,
} from "./types.ts";
```

- [ ] **Step 3: Typecheck the whole package**

Run: `cd packages/tui && bun run typecheck && bun test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/tui/src/run-manage.tsx packages/tui/src/index.ts
git commit -m "tui: runManage entry + dash exports"
```

---

## Task 12: DashConfig loader (wrapper)

**Files:**
- Modify: `packages/wrapper/src/profile.ts`
- Modify: `packages/wrapper/src/index.ts:21`
- Test: `packages/wrapper/tests/dash-config.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect } from "bun:test";
import { parseDashSection } from "../src/profile.ts";

test("empty/undefined section yields {}", () => {
  expect(parseDashSection(undefined)).toEqual({});
  expect(parseDashSection({})).toEqual({});
});

test("valid fields parse", () => {
  expect(parseDashSection({ preview: "mirror", interval: 2, status: "active", sort: "activity" }))
    .toEqual({ preview: "mirror", interval: 2, status: "active", sort: "activity" });
});

test("invalid preview throws", () => {
  expect(() => parseDashSection({ preview: "nope" })).toThrow(/preview must be/);
});

test("invalid interval throws", () => {
  expect(() => parseDashSection({ interval: 0 })).toThrow(/interval must be/);
});

test("invalid status throws", () => {
  expect(() => parseDashSection({ status: "bogus" })).toThrow(/status must be/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/wrapper && bun test dash-config.test.ts`
Expected: FAIL with "parseDashSection is not a function" / not exported.

- [ ] **Step 3: Add the loader to profile.ts**

Append to `packages/wrapper/src/profile.ts` (after `parseLsSection`/`loadLsConfig`):

```ts
export interface DashConfig {
  preview?: "mirror" | "events" | "detail";
  interval?: number; // seconds
  status?: string;   // group alias or comma-separated statuses (pre-validated)
  sort?: "started" | "activity";
}

export function parseDashSection(raw: unknown): DashConfig {
  if (raw === undefined) return {};
  if (typeof raw !== "object" || raw === null) throw new Error("[dash] must be a table");
  const r = raw as Record<string, unknown>;
  const out: DashConfig = {};
  if (r.preview !== undefined) {
    if (r.preview !== "mirror" && r.preview !== "events" && r.preview !== "detail")
      throw new Error(`[dash] preview must be 'mirror', 'events' or 'detail', got ${JSON.stringify(r.preview)}`);
    out.preview = r.preview;
  }
  if (r.interval !== undefined) {
    if (typeof r.interval !== "number" || !(r.interval > 0))
      throw new Error(`[dash] interval must be a positive number, got ${JSON.stringify(r.interval)}`);
    out.interval = r.interval;
  }
  if (r.status !== undefined) {
    if (typeof r.status !== "string" || expandStatusFilter(r.status) === null)
      throw new Error(`[dash] status must be active|open|closed or comma-separated statuses, got ${JSON.stringify(r.status)}`);
    out.status = r.status;
  }
  if (r.sort !== undefined) {
    if (r.sort !== "started" && r.sort !== "activity")
      throw new Error(`[dash] sort must be 'started' or 'activity', got ${JSON.stringify(r.sort)}`);
    out.sort = r.sort;
  }
  return out;
}

export function loadDashConfig(configPath: string): DashConfig {
  if (!fs.existsSync(configPath)) return {};
  const raw = parseToml(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
  return parseDashSection(raw.dash);
}
```

- [ ] **Step 4: Export from wrapper index**

In `packages/wrapper/src/index.ts:21`, extend the re-export to include the new symbols:

```ts
export { loadProfile, parseConfig, expandTilde, loadLsConfig, parseLsSection, loadDashConfig, parseDashSection, type ProfileConfig, type AgmuxConfig, type LsConfig, type DashConfig } from "./profile.ts";
```

- [ ] **Step 5: Run tests + typecheck**

Run: `cd packages/wrapper && bun test dash-config.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/wrapper/src/profile.ts packages/wrapper/src/index.ts packages/wrapper/tests/dash-config.test.ts
git commit -m "wrapper: [dash] config loader"
```

---

## Task 13: cli PreviewSource implementation

**Files:**
- Create: `packages/cli/src/dash-preview.ts`
- Test: `packages/cli/tests/dash-preview.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect } from "bun:test";
import type { SessionRow } from "@agmux/protocol";
import { buildCapturePaneArgs, makePreviewSource } from "../src/dash-preview.ts";

function mkRow(over: Partial<SessionRow> = {}): SessionRow {
  return {
    session_id: "s1", agent_kind: "claude", profile: null, native_session_id: null,
    command: "claude", args: [], env_overrides: {}, cwd: "/tmp", pid: 1,
    tmux_session: "agmux", tmux_window: "@1", tmux_pane: "%1", host: "h", project: null,
    parent_session_id: null, start_ts: "2026-06-11T10:00:00.000Z", last_heartbeat_ts: null,
    end_ts: null, exit_code: null, signal: null, status: "running", origin: "native",
    turn_count: null, last_tool: null, last_tool_detail: null, last_input_kind: null, activity_ts: null, ...over,
  };
}

test("buildCapturePaneArgs targets the pane in print mode", () => {
  expect(buildCapturePaneArgs("%9")).toEqual(["capture-pane", "-p", "-t", "%9"]);
});

test("mirror returns '' for a dead or pane-less session (no tmux call)", async () => {
  let called = false;
  const src = makePreviewSource("http://h", async () => { called = true; return "x"; });
  expect(await src.mirror(mkRow({ status: "ended", tmux_pane: null }))).toBe("");
  expect(called).toBe(false);
});

test("mirror runs capture-pane for a live session", async () => {
  const src = makePreviewSource("http://h", async (args) => `ran ${args.join(" ")}`);
  expect(await src.mirror(mkRow())).toBe("ran capture-pane -p -t %1");
});

test("events fetches the hub /events endpoint", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    expect(url).toBe("http://h/events?session_id=s1&limit=100");
    return new Response(JSON.stringify({ events: [{ event_id: "1", ts: "t", session_id: "s1", kind: "turn.started", version: 1, host: "h", payload: {} }] }), { status: 200 });
  }) as typeof fetch;
  try {
    const src = makePreviewSource("http://h");
    const ev = await src.events(mkRow());
    expect(ev[0]!.kind).toBe("turn.started");
  } finally { globalThis.fetch = orig; }
});

test("usage maps the hub usage row, null when absent", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    session: mkRow(), events: [],
    usage: { session_id: "s1", input_tokens: 10, output_tokens: 5, reasoning_output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0.5, last_model: "m", last_rate_limit: null, turn_count: 3 },
  }), { status: 200 })) as typeof fetch;
  try {
    const src = makePreviewSource("http://h");
    expect(await src.usage(mkRow())).toEqual({ input_tokens: 10, output_tokens: 5, cost_usd: 0.5, last_model: "m", turn_count: 3 });
  } finally { globalThis.fetch = orig; }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/cli && bun test dash-preview.test.ts`
Expected: FAIL with "Cannot find module '../src/dash-preview.ts'".

- [ ] **Step 3: Write the implementation**

```ts
import type { SessionRow, EventEnvelope } from "@agmux/protocol";
import { LIVE_STATUSES } from "@agmux/protocol";
import type { PreviewSource, UsageSummary } from "@agmux/tui";

export function buildCapturePaneArgs(pane: string): string[] {
  // -p prints the pane content to stdout; -t targets the (server-global) pane id.
  return ["capture-pane", "-p", "-t", pane];
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

export function makePreviewSource(hubUrl: string, tmuxText: TmuxText = defaultTmuxText): PreviewSource {
  return {
    async mirror(row: SessionRow): Promise<string> {
      if (!LIVE_STATUSES.includes(row.status) || !row.tmux_pane) return "";
      return tmuxText(buildCapturePaneArgs(row.tmux_pane));
    },
    async events(row: SessionRow): Promise<EventEnvelope[]> {
      const r = await fetch(`${hubUrl}/events?session_id=${row.session_id}&limit=100`);
      if (!r.ok) throw new Error(`hub error ${r.status}`);
      const { events } = (await r.json()) as { events: EventEnvelope[] };
      return events;
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/cli && bun test dash-preview.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/dash-preview.ts packages/cli/tests/dash-preview.test.ts
git commit -m "cli: dash PreviewSource (capture-pane + events + usage)"
```

---

## Task 14: cli Actions implementation

**Files:**
- Create: `packages/cli/src/dash-actions.ts`

(Attach/kill/resume reuse already-tested helpers — `buildAttachCommands`, `process.kill`, `buildRelaunchSpec`; no new standalone test beyond the typecheck. The handoff argv shape is covered by the existing `buildAttachCommands` behavior.)

- [ ] **Step 1: Write the implementation**

```ts
import { $ } from "bun";
import type { SessionRow } from "@agmux/protocol";
import { LIVE_STATUSES } from "@agmux/protocol";
import type { Actions, Handoff } from "@agmux/tui";
import { createDefaultRegistry } from "@agmux/adapters";
import { buildAttachCommands } from "./attach.ts";
import { buildRelaunchSpec } from "./relaunch.ts";

export function makeActions(hubUrl: string, wrapBin: string): Actions {
  const inTmux = !!process.env.TMUX;
  return {
    // In tmux → switch-client inline (TUI stays alive), return null.
    // Not in tmux → return a Handoff so the entry hands the terminal to a
    // blocking attach-session after ink unmounts.
    async attach(row: SessionRow): Promise<Handoff | null> {
      if (!LIVE_STATUSES.includes(row.status) || !row.tmux_session || !row.tmux_window) return null;
      const cmds = buildAttachCommands(
        { tmux_session: row.tmux_session, tmux_window: row.tmux_window, tmux_pane: row.tmux_pane },
        inTmux,
      );
      if (inTmux) { for (const args of cmds) await $`tmux ${args}`.quiet(); return null; }
      return { argv: ["tmux", ...cmds[0]!] };
    },
    async kill(row: SessionRow): Promise<void> {
      if (!row.pid) return;
      try { process.kill(row.pid, "SIGTERM"); } catch { /* already gone */ }
    },
    // Resume always hands off: the relaunched wrapper wants the terminal.
    async resume(row: SessionRow): Promise<Handoff> {
      const r = await fetch(`${hubUrl}/sessions/${row.session_id}`);
      const { session, usage } = (await r.json()) as { session: SessionRow; usage: { turn_count: number } | null };
      const spec = buildRelaunchSpec(session, {
        hubUrl, wrapBin, registry: createDefaultRegistry(), baseEnv: process.env,
        turnCount: usage?.turn_count ?? 0,
      });
      return { argv: spec.wrapArgv, env: spec.env };
    },
  };
}
```

- [ ] **Step 2: Typecheck**

Run: `cd packages/cli && bun run typecheck`
Expected: PASS. (If `buildRelaunchSpec`'s return field names differ, align this file to them — confirm by reading `packages/cli/src/relaunch.ts`; `attach.ts` uses `spec.wrapArgv` and `spec.env`.)

- [ ] **Step 3: Commit**

```bash
git add packages/cli/src/dash-actions.ts
git commit -m "cli: dash Actions (attach/kill/resume handoff)"
```

---

## Task 15: parse-dash arg parser

**Files:**
- Create: `packages/cli/src/parse-dash.ts`
- Test: `packages/cli/tests/parse-dash.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect } from "bun:test";
import { parseDashArgs } from "../src/parse-dash.ts";

test("defaults: events preview, 1s interval, open status, started sort", () => {
  const p = parseDashArgs([], {});
  expect(p.kind).toBe("ok");
  if (p.kind !== "ok") return;
  expect(p.opts.preview).toBe("events");
  expect(p.opts.intervalMs).toBe(1000);
  expect(p.opts.status).toBe("open");
  expect(p.opts.sort).toBe("started");
});

test("config supplies preview/interval/status/sort defaults", () => {
  const p = parseDashArgs([], { preview: "detail", interval: 2, status: "active", sort: "activity" });
  expect(p.kind).toBe("ok");
  if (p.kind !== "ok") return;
  expect(p.opts.preview).toBe("detail");
  expect(p.opts.intervalMs).toBe(2000);
  expect(p.opts.status).toBe("active");
  expect(p.opts.sort).toBe("activity");
});

test("--preview flag overrides config", () => {
  const p = parseDashArgs(["--preview", "mirror"], { preview: "detail" });
  expect(p.kind === "ok" && p.opts.preview).toBe("mirror");
});

test("--preview rejects bad values", () => {
  const p = parseDashArgs(["--preview", "nope"], {});
  expect(p.kind).toBe("error");
});

test("-i overrides interval; ls flags still parse", () => {
  const p = parseDashArgs(["-i", "3", "--agent", "claude"], {});
  expect(p.kind).toBe("ok");
  if (p.kind !== "ok") return;
  expect(p.opts.intervalMs).toBe(3000);
  expect(p.opts.agent).toBe("claude");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/cli && bun test parse-dash.test.ts`
Expected: FAIL with "Cannot find module '../src/parse-dash.ts'".

- [ ] **Step 3: Write the implementation**

```ts
import type { DashConfig, LsConfig } from "@agmux/wrapper";
import type { PreviewMode } from "@agmux/tui";
import { parseLsArgs, type LsQueryOpts } from "./parse-ls.ts";

export interface DashOpts extends LsQueryOpts {
  intervalMs: number;
  preview: PreviewMode;
}

export type ParsedDash =
  | { kind: "ok"; opts: DashOpts }
  | { kind: "error"; message: string };

function isPreview(v: string): v is PreviewMode {
  return v === "mirror" || v === "events" || v === "detail";
}

export function parseDashArgs(argv: string[], cfg: DashConfig): ParsedDash {
  const rest: string[] = [];
  let intervalSec: number | undefined;
  let preview: PreviewMode | undefined;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const eq = a.indexOf("=");
    const name = eq >= 0 ? a.slice(0, eq) : a;
    if (name === "-i" || name === "--interval") {
      const v = eq >= 0 ? a.slice(eq + 1) : argv[++i];
      const num = v === undefined ? NaN : Number(v);
      if (!Number.isFinite(num) || num <= 0)
        return { kind: "error", message: `dash: ${name} requires a positive number of seconds` };
      intervalSec = num;
    } else if (name === "--preview") {
      const v = eq >= 0 ? a.slice(eq + 1) : argv[++i];
      if (!v || !isPreview(v))
        return { kind: "error", message: "dash: --preview must be 'mirror', 'events' or 'detail'" };
      preview = v;
    } else {
      rest.push(a);
    }
  }

  // ls defaults: dash mirrors watch (status=open, sort=started) unless config overrides.
  const lsDefaults: LsConfig = { status: cfg.status ?? "open", sort: cfg.sort ?? "started" };
  const parsed = parseLsArgs(rest, lsDefaults);
  if (parsed.kind === "error")
    return { kind: "error", message: parsed.message.replace(/^ls:/, "dash:") };

  return {
    kind: "ok",
    opts: {
      ...parsed.opts,
      intervalMs: Math.round((intervalSec ?? cfg.interval ?? 1) * 1000),
      preview: preview ?? cfg.preview ?? "events",
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/cli && bun test parse-dash.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/parse-dash.ts packages/cli/tests/parse-dash.test.ts
git commit -m "cli: dash arg parsing"
```

---

## Task 16: dashCmd + bin wiring

**Files:**
- Create: `packages/cli/src/dash.ts`
- Test: `packages/cli/tests/dash.test.ts`
- Modify: `packages/cli/bin/agmux.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect } from "bun:test";
import { dashCmd, type DashCmdDeps } from "../src/dash.ts";
import type { DashOpts } from "../src/parse-dash.ts";

const opts: DashOpts & { hubUrl: string; wrapBin: string } = {
  limit: 50, sort: "started", asc: false, reverse: false, status: "open",
  intervalMs: 1000, preview: "events", hubUrl: "http://h", wrapBin: "agmux-wrap",
};

test("non-TTY returns 2 and prints a hint", async () => {
  let err = "";
  const deps: DashCmdDeps = {
    isTTY: () => false,
    runManageImpl: async () => 0,
    makeSourceImpl: () => ({ async mirror() { return ""; }, async events() { return []; }, async usage() { return null; } }),
    makeActionsImpl: () => ({ async attach() { return null; }, async kill() {}, async resume() { return { argv: [] }; } }),
    errOut: (s) => { err = s; },
  };
  expect(await dashCmd(opts, deps)).toBe(2);
  expect(err).toContain("requires a TTY");
});

test("TTY path forwards preview + interval to runManage", async () => {
  let seen: { defaultPreview?: string; intervalMs?: number } = {};
  const deps: DashCmdDeps = {
    isTTY: () => true,
    runManageImpl: async (o) => { seen = { defaultPreview: o.defaultPreview, intervalMs: o.intervalMs }; return 0; },
    makeSourceImpl: () => ({ async mirror() { return ""; }, async events() { return []; }, async usage() { return null; } }),
    makeActionsImpl: () => ({ async attach() { return null; }, async kill() {}, async resume() { return { argv: [] }; } }),
    errOut: () => {},
  };
  expect(await dashCmd(opts, deps)).toBe(0);
  expect(seen).toEqual({ defaultPreview: "events", intervalMs: 1000 });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/cli && bun test dash.test.ts`
Expected: FAIL with "Cannot find module '../src/dash.ts'".

- [ ] **Step 3: Write dash.ts**

```ts
import { runManage, type RunManageOpts, type PreviewSource, type Actions } from "@agmux/tui";
import { buildLsQuery } from "./ls.ts";
import { makePreviewSource } from "./dash-preview.ts";
import { makeActions } from "./dash-actions.ts";
import type { DashOpts } from "./parse-dash.ts";

export interface DashCmdDeps {
  isTTY: () => boolean;
  runManageImpl: (o: RunManageOpts) => Promise<number>;
  makeSourceImpl: (hubUrl: string) => PreviewSource;
  makeActionsImpl: (hubUrl: string, wrapBin: string) => Actions;
  errOut: (s: string) => void;
}

const defaultDeps: DashCmdDeps = {
  isTTY: () => Boolean(process.stdout.isTTY && process.stdin.isTTY),
  runManageImpl: runManage,
  makeSourceImpl: makePreviewSource,
  makeActionsImpl: makeActions,
  errOut: (s) => console.error(s),
};

export async function dashCmd(
  opts: DashOpts & { hubUrl: string; wrapBin: string },
  deps: DashCmdDeps = defaultDeps,
): Promise<number> {
  if (!deps.isTTY()) {
    deps.errOut("dash: requires a TTY (use `agmux ls` for scripted output)");
    return 2;
  }
  return deps.runManageImpl({
    hubUrl: opts.hubUrl,
    query: buildLsQuery(opts),
    intervalMs: opts.intervalMs,
    defaultPreview: opts.preview,
    source: deps.makeSourceImpl(opts.hubUrl),
    actions: deps.makeActionsImpl(opts.hubUrl, opts.wrapBin),
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/cli && bun test dash.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Wire the verb into bin/agmux.ts**

In `packages/cli/bin/agmux.ts`:

(a) Add imports near the other src imports (after line 10):
```ts
import { dashCmd } from "../src/dash.ts";
import { parseDashArgs } from "../src/parse-dash.ts";
```

(b) Extend the `loadLsConfig` import on line 21 to also pull `loadDashConfig`:
```ts
import { loadProfile, loadLsConfig, loadDashConfig, type LsConfig } from "@agmux/wrapper";
```

(c) Add a usage line after the `watch` line (line 41 area):
```ts
  dash [ls flags] [-i/--interval <seconds>] [--preview <mirror|events|detail>]
     interactive TUI: grouped sessions + preview; ⏎ attach, x kill, r resume, q quit
```

(d) Add the `case "dash"` block after the `watch` case (after line 158):
```ts
    case "dash": {
      const configPath = path.join(os.homedir(), AGMUX_CONFIG_SUBPATH);
      let dashDefaults;
      try { dashDefaults = loadDashConfig(configPath); }
      catch (e) { console.error(e instanceof Error ? e.message : String(e)); return 2; }
      const parsed = parseDashArgs(argv.slice(1), dashDefaults);
      if (parsed.kind === "error") { console.error(parsed.message); return 2; }
      return dashCmd({ ...parsed.opts, hubUrl, wrapBin });
    }
```

- [ ] **Step 6: Typecheck + full cli suite**

Run: `cd packages/cli && bun run typecheck && bun test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/dash.ts packages/cli/tests/dash.test.ts packages/cli/bin/agmux.ts
git commit -m "cli: agmux dash verb"
```

---

## Task 17: Build, docs, manual smoke

**Files:**
- Modify: `README.md` (the verb list / usage section, alongside `watch`)

- [ ] **Step 1: Full workspace typecheck + tests**

Run (from repo root): `bun run typecheck && bun test`
Expected: PASS across all packages.

- [ ] **Step 2: Build the cli binary**

Run: `cd packages/cli && bun run build`
Expected: builds `dist/agmux` with no errors.

- [ ] **Step 3: Document the verb in README.md**

Add next to the existing `agmux watch` documentation:

```markdown
### agmux dash

Interactive TUI (lazygit-style): grouped session table + preview pane.

    agmux dash                         # status open, sorted by start
    agmux dash -i 2 --agent claude     # accepts ls filter flags + -i/--interval
    agmux dash --preview detail        # default preview tab (mirror|events|detail)

Keys: `j/k` move · `{ }` group jump · `< >` resize split · `tab` preview ·
`⏎` attach (switch-client) · `x` kill · `r` resume closed · `/` filter · `?` help · `q` quit.

Config under `[dash]` in `~/.config/agmux/config.toml`: `preview`, `interval`, `status`, `sort`.
Run it inside tmux so `⏎` switches you to the agent's window while dash stays alive.
```

- [ ] **Step 4: Manual smoke (requires a live hub + at least one session in tmux)**

Run: `./packages/cli/dist/agmux dash`
Verify: grouped table renders; `j/k` move; `tab` cycles `mirror/events/detail`; `<`/`>` resize; `?` help; `q` quits and restores the screen. With a live session selected, `⏎` switches the tmux client to its window.

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: agmux dash verb"
```

---

## Self-review notes (verified during planning)

- **Spec coverage:** new verb `agmux dash` keeping `watch` (Task 16) ✓ · Layout B grouped table + resizable split (Tasks 3, 7, 9) ✓ · columns ID/AGENT/PROFILE/ACTIVITY/TURNS/LAST with status group headers (Task 3) ✓ · group order NEEDS INPUT→WORKING→IDLE→CLOSED (Task 3) ✓ · three preview modes toggleable + config default + mirror→events fallback (Tasks 4,5,8,9,12) ✓ · attach via switch-client / handoff when not in tmux (Tasks 9,11,14) ✓ · kill with confirm + resume dead (Tasks 9,14) ✓ · `[dash]` config (Task 12) ✓ · pure-tui / injected-deps boundary (Tasks 2,13,14) ✓ · edge cases: non-TTY exit 2 (Task 16), dead/pane-less mirror fallback (Tasks 9,13), narrow-terminal split clamp 0.3–0.8 (Task 9) ✓ · testing approach mirrors `watch-app.test.tsx`/`format.test.ts` (Tasks 3,10) ✓.
- **Future seams:** `view` enum (Usage view) and pluggable group-by are intentionally NOT built — the status grouping lives in `group-table.ts` as a single function easy to generalize later.
- **Type consistency:** `PreviewSource`/`Actions`/`Handoff`/`UsageSummary`/`PreviewMode` defined once in `types.ts` (Task 2), imported everywhere; `RunManageOpts` shape matches between `run-manage.tsx` (Task 11) and `dash.ts` (Task 16); `DashConfig`/`DashOpts` fields align across Tasks 12 and 15.
