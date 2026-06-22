# OpenTUI `dash` Spike Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a flag-gated OpenTUI (React) implementation of `agmux dash` alongside the existing Ink one, reusing the current data layer, to evaluate smooth navigation + the target visual UX (distinct panels, color-coded status, mouse, vim keys).

**Architecture:** New OpenTUI code lives in `packages/tui/src/opentui/`; pure framework-agnostic rendering logic is extracted to `packages/tui/src/shared/` (unit-tested without a renderer and shared by both bindings). The existing `PollingSessionFeed`, `@agmux/protocol`, `PreviewSource`, and `Actions` are reused unchanged. The CLI selects the implementation at runtime via the `AGMUX_TUI` env var (`ink` default | `opentui`). Ink stays the default and is untouched.

**Tech Stack:** Bun, TypeScript, React 19, `@opentui/core` + `@opentui/react` (native Zig renderer over Bun FFI), `bun:test`.

**Spec:** `docs/superpowers/specs/2026-06-20-opentui-dash-spike-design.md`

---

## File Structure

**New — pure logic (no framework imports, fully unit-tested):**
- `packages/tui/src/shared/glyph.ts` — `SessionRow.status` → `{ glyph, color }`
- `packages/tui/src/shared/reltime.ts` — ISO timestamp → relative string
- `packages/tui/src/shared/columns.ts` — per-row cell strings, column defs, width + padding helpers
- `packages/tui/src/shared/sort.ts` — default status-priority sort + cycle
- `packages/tui/src/shared/filter.ts` — substring filter across id/agent/profile/tmux/status

**New — OpenTUI React binding:**
- `packages/tui/src/opentui/run-manage-otui.tsx` — renderer lifecycle, `createRoot`, handoff handling (mirror of `run-manage.tsx`)
- `packages/tui/src/opentui/DashApp.tsx` — root component: feed subscription + UI state + layout + input
- `packages/tui/src/opentui/HeaderBar.tsx` — title + connection + status counts
- `packages/tui/src/opentui/SessionTable.tsx` — the hero table (scrollbox of rows)
- `packages/tui/src/opentui/PreviewPane.tsx` — tabbed aside (mirror/events/detail, mode-keyed body)
- `packages/tui/src/opentui/FooterBar.tsx` — keybind hints / filter line / kill confirm
- `packages/tui/src/opentui/attached.ts` — best-effort attached-session detection

**New — tests:**
- `packages/tui/tests/helpers/mk-row.ts` — shared `SessionRow` factory for new tests
- `packages/tui/tests/shared/glyph.test.ts`, `reltime.test.ts`, `columns.test.ts`, `sort.test.ts`, `filter.test.ts`
- `packages/tui/tests/opentui/dash-app.test.tsx` — render + interaction smoke test

**Modified:**
- `packages/tui/package.json` — add `@opentui/core`, `@opentui/react`
- `packages/tui/src/index.ts` — export `runManageOtui`
- `packages/cli/src/dash.ts` — branch on `AGMUX_TUI`

---

## Task 1: Add OpenTUI dependencies

**Files:**
- Modify: `packages/tui/package.json`

- [ ] **Step 1: Add the dependencies**

Edit `packages/tui/package.json` so the `dependencies` block reads:

```json
  "dependencies": {
    "@agmux/protocol": "workspace:*",
    "@opentui/core": "^0.1.27",
    "@opentui/react": "^0.1.27",
    "ink": "7.0.5",
    "react": "19.2.7"
  },
```

(Keep `ink` and `react`; OpenTUI's React binding uses the same `react`. Pin to the latest published `@opentui/*` version — verify with `bun info @opentui/core version` and use that exact major.minor in both lines.)

- [ ] **Step 2: Install**

Run: `bun install`
Expected: lockfile updates, `@opentui/core` and `@opentui/react` resolve without peer-dependency errors.

- [ ] **Step 3: Verify native renderer loads under Bun**

Create a throwaway `packages/tui/scratch-otui.ts`:

```typescript
import { createCliRenderer } from "@opentui/core";

const renderer = await createCliRenderer({ screenMode: "main-screen", exitOnCtrlC: true });
console.log("renderer ok:", renderer.width, "x", renderer.height);
renderer.destroy();
```

Run: `bun packages/tui/scratch-otui.ts`
Expected: prints `renderer ok: <cols> x <rows>` and exits cleanly (proves Bun FFI + native core work here). Then delete the file: `rm packages/tui/scratch-otui.ts`.

- [ ] **Step 4: Commit**

```bash
git add packages/tui/package.json bun.lock
git commit -m "tui: add @opentui/core + @opentui/react deps"
```

---

## Task 2: Confirm OpenTUI React JSX + test-renderer API

This de-risks every later component task by pinning the exact prop spellings and test-input API against the *installed* package, so subsequent code is not guessed.

**Files:**
- Create (temporary): `packages/tui/scratch-jsx.tsx`

- [ ] **Step 1: Render a panel + capture a frame + drive a key**

Create `packages/tui/scratch-jsx.tsx`:

```tsx
/** @jsxImportSource @opentui/react */
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot, useKeyboard } from "@opentui/react";
import { useState } from "react";

function Probe() {
  const [n, setN] = useState(0);
  useKeyboard((key) => { if (key.name === "j") setN((x) => x + 1); });
  return (
    <box style={{ border: true, flexDirection: "column" }} title="Sessions">
      <text fg="#f9e2af">count {n}</text>
    </box>
  );
}

const { renderer, renderOnce, captureCharFrame, mockInput } = await createTestRenderer({ width: 40, height: 8 });
createRoot(renderer).render(<Probe />);
await renderOnce();
console.log(captureCharFrame());
console.log("mockInput keys:", Object.keys(mockInput));
renderer.destroy();
```

- [ ] **Step 2: Run it and record the real API**

Run: `bun packages/tui/scratch-jsx.tsx`
Expected: a bordered frame containing `Sessions` and `count 0` prints, plus the list of `mockInput` method names.

Record these confirmed facts in a comment at the top of `packages/tui/src/opentui/run-manage-otui.tsx` (created in Task 9) — specifically:
- whether `<box>` takes `title` directly and layout/border under `style` (expected: yes),
- whether `<text>` takes `fg` directly (expected: yes),
- the exact `mockInput` method for sending a keypress (e.g. `pressKey`, `sendKey`, or `typeText`) — used by Task 16's test.

If any spelling differs from this plan's assumptions, adjust the later tasks' code to match the recorded API. Then delete the scratch file: `rm packages/tui/scratch-jsx.tsx`.

- [ ] **Step 3: Commit (notes only, no scratch file)**

No commit needed if only the scratch file changed and was deleted. If you captured API notes somewhere tracked, commit them.

---

## Task 3: Shared test-row factory

**Files:**
- Create: `packages/tui/tests/helpers/mk-row.ts`

- [ ] **Step 1: Write the factory**

```typescript
import type { SessionRow } from "@agmux/protocol";

export function mkRow(over: Partial<SessionRow> = {}): SessionRow {
  return {
    session_id: "agx-000000001", agent_kind: "claude", profile: null, native_session_id: null,
    command: "claude", args: [], env_overrides: {}, cwd: "/tmp", pid: 1,
    tmux_session: null, tmux_window: null, tmux_pane: null, host: "h", project: null,
    parent_session_id: null, start_ts: "2026-06-20T10:00:00.000Z", last_heartbeat_ts: null,
    end_ts: null, exit_code: null, signal: null, status: "running", origin: "native",
    turn_count: null, last_tool: null, last_tool_detail: null, last_input_kind: null,
    activity_ts: null, ...over,
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/tui/tests/helpers/mk-row.ts
git commit -m "tui: shared mkRow test factory for opentui dash"
```

---

## Task 4: `shared/glyph.ts` — status → glyph + color

**Files:**
- Create: `packages/tui/src/shared/glyph.ts`
- Test: `packages/tui/tests/shared/glyph.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { test, expect } from "bun:test";
import { statusGlyph } from "../../src/shared/glyph.ts";
import { mkRow } from "../helpers/mk-row.ts";

test("waiting → amber warning", () => {
  expect(statusGlyph(mkRow({ status: "waiting" }))).toEqual({ glyph: "⚠", color: "#f9e2af" });
});
test("running → green dot", () => {
  expect(statusGlyph(mkRow({ status: "running" }))).toEqual({ glyph: "●", color: "#a6e3a1" });
});
test("idle → grey ring", () => {
  expect(statusGlyph(mkRow({ status: "idle" }))).toEqual({ glyph: "○", color: "#6c7086" });
});
test("ended clean → muted dot (closed)", () => {
  expect(statusGlyph(mkRow({ status: "ended", exit_code: 0 }))).toEqual({ glyph: "·", color: "#585b70" });
});
test("ended non-zero → red error", () => {
  expect(statusGlyph(mkRow({ status: "ended", exit_code: 1 }))).toEqual({ glyph: "✖", color: "#f38ba8" });
});
test("ended on signal → red error", () => {
  expect(statusGlyph(mkRow({ status: "ended", exit_code: null, signal: "SIGTERM" }))).toEqual({ glyph: "✖", color: "#f38ba8" });
});
test("lost → muted dot (closed, not error)", () => {
  expect(statusGlyph(mkRow({ status: "lost" }))).toEqual({ glyph: "·", color: "#585b70" });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/tui/tests/shared/glyph.test.ts`
Expected: FAIL — `Cannot find module '../../src/shared/glyph.ts'`.

- [ ] **Step 3: Write the implementation**

```typescript
import type { SessionRow } from "@agmux/protocol";

export interface Glyph {
  glyph: string;
  color: string;
}

const RUNNING: Glyph = { glyph: "●", color: "#a6e3a1" };
const WAITING: Glyph = { glyph: "⚠", color: "#f9e2af" };
const IDLE: Glyph = { glyph: "○", color: "#6c7086" };
const ERROR: Glyph = { glyph: "✖", color: "#f38ba8" };
const CLOSED: Glyph = { glyph: "·", color: "#585b70" };

// `lost` is treated as closed (muted), not error. Only an `ended` session that
// exited non-zero or on a signal earns the red error glyph.
export function statusGlyph(r: SessionRow): Glyph {
  switch (r.status) {
    case "waiting": return WAITING;
    case "running": return RUNNING;
    case "idle": return IDLE;
    case "ended":
      return (r.exit_code != null && r.exit_code !== 0) || r.signal ? ERROR : CLOSED;
    case "lost": return CLOSED;
    default: return CLOSED;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/tui/tests/shared/glyph.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/tui/src/shared/glyph.ts packages/tui/tests/shared/glyph.test.ts
git commit -m "tui: shared status glyph mapping"
```

---

## Task 5: `shared/reltime.ts` — relative time

**Files:**
- Create: `packages/tui/src/shared/reltime.ts`
- Test: `packages/tui/tests/shared/reltime.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { test, expect } from "bun:test";
import { relTime } from "../../src/shared/reltime.ts";

const NOW = Date.parse("2026-06-20T12:00:00.000Z");

test("seconds", () => { expect(relTime("2026-06-20T11:59:57.000Z", NOW)).toBe("3s"); });
test("clamps negative (clock skew) to 0s", () => { expect(relTime("2026-06-20T12:00:05.000Z", NOW)).toBe("0s"); });
test("minutes", () => { expect(relTime("2026-06-20T11:50:00.000Z", NOW)).toBe("10m"); });
test("hours", () => { expect(relTime("2026-06-20T09:00:00.000Z", NOW)).toBe("3h"); });
test("yesterday at exactly 1 day", () => { expect(relTime("2026-06-19T12:00:00.000Z", NOW)).toBe("yesterday"); });
test("days under a week", () => { expect(relTime("2026-06-17T12:00:00.000Z", NOW)).toBe("3d"); });
test("falls back to YYYY-MM-DD beyond a week", () => { expect(relTime("2026-06-02T12:00:00.000Z", NOW)).toBe("2026-06-02"); });
test("invalid input → dash", () => { expect(relTime("not-a-date", NOW)).toBe("-"); });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/tui/tests/shared/reltime.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
// Relative time for the LAST column. `now` is injected (Date.now() in the app)
// so it's deterministic in tests. Recomputed each render — the feed's 1s poll
// re-render keeps "3s → 4s" live without a dedicated timer.
export function relTime(iso: string, now: number): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "-";
  const s = Math.max(0, Math.floor((now - then) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d === 1) return "yesterday";
  if (d < 7) return `${d}d`;
  return iso.slice(0, 10);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/tui/tests/shared/reltime.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/tui/src/shared/reltime.ts packages/tui/tests/shared/reltime.test.ts
git commit -m "tui: shared relative-time formatter"
```

---

## Task 6: `shared/columns.ts` — cells, widths, padding

**Files:**
- Create: `packages/tui/src/shared/columns.ts`
- Test: `packages/tui/tests/shared/columns.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { test, expect } from "bun:test";
import { rowCells, COLS, columnWidths, pad, ID_MAX, TMUX_MAX } from "../../src/shared/columns.ts";
import { mkRow } from "../helpers/mk-row.ts";

const NOW = Date.parse("2026-06-20T12:00:00.000Z");

test("ID truncates to 13 chars with NO ellipsis", () => {
  const c = rowCells(mkRow({ session_id: "agx-9d2c1a0f4abcdef" }), NOW);
  expect(c.id).toBe("agx-9d2c1a0f4");
  expect(c.id.length).toBe(ID_MAX);
  expect(c.id.endsWith("…")).toBe(false);
});

test("TMUX joins session:window, truncates at 32 WITH ellipsis", () => {
  const short = rowCells(mkRow({ tmux_session: "main", tmux_window: "agmux.1" }), NOW);
  expect(short.tmux).toBe("main:agmux.1");
  const long = rowCells(mkRow({ tmux_session: "spike", tmux_window: "pty-experiment-longwindowname" }), NOW);
  expect(long.tmux.length).toBe(TMUX_MAX);
  expect(long.tmux.endsWith("…")).toBe(true);
});

test("TMUX em-dash when missing", () => {
  expect(rowCells(mkRow({ tmux_session: null, tmux_window: null }), NOW).tmux).toBe("—");
});

test("turns: null → dash, number → string", () => {
  expect(rowCells(mkRow({ turn_count: null }), NOW).turns).toBe("-");
  expect(rowCells(mkRow({ turn_count: 0 }), NOW).turns).toBe("0");
  expect(rowCells(mkRow({ turn_count: 14 }), NOW).turns).toBe("14");
});

test("last uses last_heartbeat_ts, falls back to start_ts", () => {
  expect(rowCells(mkRow({ last_heartbeat_ts: "2026-06-20T11:59:57.000Z" }), NOW).last).toBe("3s");
  expect(rowCells(mkRow({ last_heartbeat_ts: null, start_ts: "2026-06-20T11:50:00.000Z" }), NOW).last).toBe("10m");
});

test("columnWidths is max(header, widest cell) per column", () => {
  const cells = [rowCells(mkRow({ agent_kind: "claude" }), NOW), rowCells(mkRow({ agent_kind: "codex" }), NOW)];
  const w = columnWidths(cells);
  expect(w.agent).toBe("AGENT".length); // "AGENT"(5) > "claude"(6)? no → 6
  // "AGENT" is 5, "claude" is 6 → width 6
  expect(w.agent).toBe(6);
});

test("pad left vs right", () => {
  expect(pad("7", 4, "right")).toBe("   7");
  expect(pad("ab", 4, "left")).toBe("ab  ");
});

test("COLS order is id,tmux,agent,profile,turns,last", () => {
  expect(COLS.map((c) => c.key)).toEqual(["id", "tmux", "agent", "profile", "turns", "last"]);
});
```

> Note: the `w.agent` assertion is `6` (the cell `"claude"` is wider than the header `"AGENT"`). Keep the explanatory comment but only the final `expect(w.agent).toBe(6)` matters.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/tui/tests/shared/columns.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
import type { SessionRow } from "@agmux/protocol";
import { relTime } from "./reltime.ts";

export const ID_MAX = 13;
export const TMUX_MAX = 32;

export interface RowCells {
  id: string;
  tmux: string;
  agent: string;
  profile: string;
  turns: string;
  last: string;
}

export type ColKey = keyof RowCells;

export interface ColDef {
  key: ColKey;
  header: string;
  align: "left" | "right";
}

// Column order: glyph is rendered separately (leading), so it is NOT in COLS.
export const COLS: ColDef[] = [
  { key: "id", header: "ID", align: "left" },
  { key: "tmux", header: "TMUX", align: "left" },
  { key: "agent", header: "AGENT", align: "left" },
  { key: "profile", header: "PROFILE", align: "left" },
  { key: "turns", header: "TURNS", align: "right" },
  { key: "last", header: "LAST", align: "right" },
];

// ID: first 13 chars, NO ellipsis (it's an opaque id; a hard cut is fine).
function idCell(r: SessionRow): string {
  return r.session_id.slice(0, ID_MAX);
}

// TMUX: session:window, truncated to 32 WITH ellipsis (human-chosen, worth reading).
function tmuxCell(r: SessionRow): string {
  if (!r.tmux_session || !r.tmux_window) return "—";
  const c = `${r.tmux_session}:${r.tmux_window}`;
  return c.length > TMUX_MAX ? c.slice(0, TMUX_MAX - 1) + "…" : c;
}

export function rowCells(r: SessionRow, now: number): RowCells {
  return {
    id: idCell(r),
    tmux: tmuxCell(r),
    agent: r.agent_kind,
    profile: r.profile ?? "-",
    turns: r.turn_count == null ? "-" : String(r.turn_count),
    last: relTime(r.last_heartbeat_ts ?? r.start_ts, now),
  };
}

export function columnWidths(cells: RowCells[]): Record<ColKey, number> {
  const w = {} as Record<ColKey, number>;
  for (const c of COLS) w[c.key] = c.header.length;
  for (const cell of cells) for (const c of COLS) w[c.key] = Math.max(w[c.key], cell[c.key].length);
  return w;
}

export function pad(s: string, width: number, align: "left" | "right"): string {
  return align === "right" ? s.padStart(width) : s.padEnd(width);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/tui/tests/shared/columns.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/tui/src/shared/columns.ts packages/tui/tests/shared/columns.test.ts
git commit -m "tui: shared table column cells + width/pad helpers"
```

---

## Task 7: `shared/sort.ts` — status-priority sort + cycle

**Files:**
- Create: `packages/tui/src/shared/sort.ts`
- Test: `packages/tui/tests/shared/sort.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { test, expect } from "bun:test";
import { sortRows, nextSort, SORT_KEYS } from "../../src/shared/sort.ts";
import { mkRow } from "../helpers/mk-row.ts";

test("default status sort: waiting → running → idle → closed", () => {
  const rows = [
    mkRow({ session_id: "i", status: "idle" }),
    mkRow({ session_id: "e", status: "ended" }),
    mkRow({ session_id: "w", status: "waiting" }),
    mkRow({ session_id: "r", status: "running" }),
  ];
  expect(sortRows(rows, "status").map((r) => r.session_id)).toEqual(["w", "r", "i", "e"]);
});

test("within a status, most-recent activity first", () => {
  const rows = [
    mkRow({ session_id: "old", status: "running", last_heartbeat_ts: "2026-06-20T10:00:00.000Z" }),
    mkRow({ session_id: "new", status: "running", last_heartbeat_ts: "2026-06-20T11:00:00.000Z" }),
  ];
  expect(sortRows(rows, "status").map((r) => r.session_id)).toEqual(["new", "old"]);
});

test("sort by last ignores status", () => {
  const rows = [
    mkRow({ session_id: "a", status: "ended", last_heartbeat_ts: "2026-06-20T11:00:00.000Z" }),
    mkRow({ session_id: "b", status: "waiting", last_heartbeat_ts: "2026-06-20T10:00:00.000Z" }),
  ];
  expect(sortRows(rows, "last").map((r) => r.session_id)).toEqual(["a", "b"]);
});

test("sort by id is lexicographic", () => {
  const rows = [mkRow({ session_id: "b" }), mkRow({ session_id: "a" })];
  expect(sortRows(rows, "id").map((r) => r.session_id)).toEqual(["a", "b"]);
});

test("sortRows does not mutate input", () => {
  const rows = [mkRow({ session_id: "b", status: "idle" }), mkRow({ session_id: "a", status: "waiting" })];
  const before = rows.map((r) => r.session_id);
  sortRows(rows, "status");
  expect(rows.map((r) => r.session_id)).toEqual(before);
});

test("nextSort cycles through SORT_KEYS", () => {
  expect(nextSort("status")).toBe("last");
  expect(nextSort("last")).toBe("id");
  expect(nextSort("id")).toBe("status");
  expect(SORT_KEYS).toEqual(["status", "last", "id"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/tui/tests/shared/sort.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
import type { SessionRow, SessionStatus } from "@agmux/protocol";

export type SortKey = "status" | "last" | "id";
export const SORT_KEYS: SortKey[] = ["status", "last", "id"];

// Needs-input first, then working, then idle, then closed (ended/lost share a rank).
const STATUS_RANK: Record<SessionStatus, number> = {
  waiting: 0, running: 1, idle: 2, ended: 3, lost: 3,
};

function tsOf(r: SessionRow): number {
  return Date.parse(r.last_heartbeat_ts ?? r.start_ts) || 0;
}

// Returns a NEW sorted array; never mutates the input.
export function sortRows(rows: SessionRow[], key: SortKey): SessionRow[] {
  const copy = [...rows];
  if (key === "status") {
    copy.sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || tsOf(b) - tsOf(a));
  } else if (key === "last") {
    copy.sort((a, b) => tsOf(b) - tsOf(a));
  } else {
    copy.sort((a, b) => a.session_id.localeCompare(b.session_id));
  }
  return copy;
}

export function nextSort(key: SortKey): SortKey {
  return SORT_KEYS[(SORT_KEYS.indexOf(key) + 1) % SORT_KEYS.length]!;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/tui/tests/shared/sort.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/tui/src/shared/sort.ts packages/tui/tests/shared/sort.test.ts
git commit -m "tui: shared session sort (status priority + cycle)"
```

---

## Task 8: `shared/filter.ts` — substring filter

**Files:**
- Create: `packages/tui/src/shared/filter.ts`
- Test: `packages/tui/tests/shared/filter.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { test, expect } from "bun:test";
import { matchesFilter, filterRows } from "../../src/shared/filter.ts";
import { mkRow } from "../helpers/mk-row.ts";

test("empty query matches everything", () => {
  expect(matchesFilter(mkRow(), "")).toBe(true);
});
test("matches id/agent/profile/tmux/status case-insensitively", () => {
  const r = mkRow({ session_id: "agx-DEADBEEF", profile: "infra", agent_kind: "codex", tmux_session: "main", tmux_window: "w1", status: "waiting" });
  expect(matchesFilter(r, "deadbeef")).toBe(true);
  expect(matchesFilter(r, "INFRA")).toBe(true);
  expect(matchesFilter(r, "codex")).toBe(true);
  expect(matchesFilter(r, "main")).toBe(true);
  expect(matchesFilter(r, "wait")).toBe(true);
  expect(matchesFilter(r, "nope")).toBe(false);
});
test("filterRows keeps only matches", () => {
  const rows = [mkRow({ session_id: "keep", agent_kind: "claude" }), mkRow({ session_id: "drop", agent_kind: "codex" })];
  expect(filterRows(rows, "claude").map((r) => r.session_id)).toEqual(["keep"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/tui/tests/shared/filter.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
import type { SessionRow } from "@agmux/protocol";

export function matchesFilter(r: SessionRow, q: string): boolean {
  if (!q) return true;
  const n = q.toLowerCase();
  return [r.session_id, r.agent_kind, r.profile ?? "", r.tmux_session ?? "", r.tmux_window ?? "", r.status]
    .some((s) => s.toLowerCase().includes(n));
}

export function filterRows(rows: SessionRow[], q: string): SessionRow[] {
  return rows.filter((r) => matchesFilter(r, q));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/tui/tests/shared/filter.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/tui/src/shared/filter.ts packages/tui/tests/shared/filter.test.ts
git commit -m "tui: shared session filter"
```

---

## Task 9: OpenTUI entry — `run-manage-otui.tsx`

This mirrors `run-manage.tsx`'s contract: same `RunManageOpts`, same handoff-after-teardown behavior, so it's a drop-in for the CLI. Starts with a minimal `DashApp` placeholder that later tasks flesh out.

**Files:**
- Create: `packages/tui/src/opentui/run-manage-otui.tsx`
- Create (minimal placeholder, expanded in Task 10): `packages/tui/src/opentui/DashApp.tsx`

- [ ] **Step 1: Minimal `DashApp` placeholder**

`packages/tui/src/opentui/DashApp.tsx`:

```tsx
/** @jsxImportSource @opentui/react */
import { useKeyboard } from "@opentui/react";
import type { SessionFeed } from "../feed.ts";
import type { Actions, Handoff, PreviewMode, PreviewSource } from "../types.ts";

export interface DashAppProps {
  feed: SessionFeed;
  source: PreviewSource;
  actions: Actions;
  hubUrl: string;
  defaultPreview: PreviewMode;
  intervalMs: number;
  onHandoff: (h: Handoff) => void;
  onQuit: () => void;
}

export function DashApp(props: DashAppProps) {
  useKeyboard((key) => {
    if (key.name === "q") props.onQuit();
  });
  return (
    <box style={{ border: true }} title="agmux dash">
      <text>connecting to {props.hubUrl}…</text>
    </box>
  );
}
```

- [ ] **Step 2: Entry with renderer lifecycle + handoff**

`packages/tui/src/opentui/run-manage-otui.tsx`:

```tsx
/** @jsxImportSource @opentui/react */
// Confirmed OpenTUI API (Task 2): <box> takes `title` directly + layout/border via
// `style`; <text> takes `fg` directly; mockInput keypress method = <RECORD HERE>.
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { PollingSessionFeed } from "../feed.ts";
import { DashApp } from "./DashApp.tsx";
import type { RunManageOpts } from "../run-manage.tsx";
import type { Handoff } from "../types.ts";

// An empty-argv Handoff means "exit, spawn nothing" (popup attach/resume after
// they retarget the parent client inline). Same sentinel as the Ink entry.
function resolveHandoff(pending: Handoff | null): Handoff | null {
  return pending && pending.argv.length > 0 ? pending : null;
}

export async function runManageOtui(o: RunManageOpts): Promise<number> {
  const feed = new PollingSessionFeed({ hubUrl: o.hubUrl, query: o.query, intervalMs: o.intervalMs });
  let pending: Handoff | null = null;

  const renderer = await createCliRenderer({
    screenMode: "alternate-screen",
    exitOnCtrlC: true,
    targetFps: 30,
  });

  const destroyed = new Promise<void>((resolve) => renderer.on("destroy", () => resolve()));

  createRoot(renderer).render(
    <DashApp
      feed={feed}
      source={o.source}
      actions={o.actions}
      hubUrl={o.hubUrl}
      defaultPreview={o.defaultPreview}
      intervalMs={o.intervalMs}
      onHandoff={(h) => { pending = h; }}
      onQuit={() => renderer.destroy()}
    />,
  );

  await destroyed; // renderer.destroy() restores the terminal (alt-screen, mouse, raw mode)

  const h = resolveHandoff(pending);
  if (h) {
    const child = Bun.spawn(h.argv, { stdio: ["inherit", "inherit", "inherit"], env: h.env ?? process.env });
    await child.exited;
    return child.exitCode ?? 0;
  }
  return 0;
}
```

- [ ] **Step 3: Typecheck**

Run: `bun run --filter '@agmux/tui' typecheck`
Expected: PASS (no type errors). If the JSX pragma is not picked up, confirm `packages/tui/tsconfig.json` has `"jsx": "react-jsx"` (it does) — the per-file `@jsxImportSource` pragma overrides the import source to `@opentui/react` for these files only.

- [ ] **Step 4: Commit**

```bash
git add packages/tui/src/opentui/run-manage-otui.tsx packages/tui/src/opentui/DashApp.tsx
git commit -m "tui: opentui dash entry + minimal DashApp"
```

---

## Task 10: `DashApp` — feed subscription, state, layout skeleton

Wire the feed (same `useSyncExternalStore` pattern as `manage-app.tsx`), derive sorted+filtered rows, and lay out header / table / preview / footer. Child components are placeholders here; later tasks fill them.

**Files:**
- Modify: `packages/tui/src/opentui/DashApp.tsx`
- Create (placeholders): `HeaderBar.tsx`, `SessionTable.tsx`, `PreviewPane.tsx`, `FooterBar.tsx`

- [ ] **Step 1: Placeholder child components**

`packages/tui/src/opentui/HeaderBar.tsx`:

```tsx
/** @jsxImportSource @opentui/react */
import type { SessionRow } from "@agmux/protocol";

export function HeaderBar(props: { rows: SessionRow[]; connected: boolean; hubUrl: string }) {
  return <text fg="#cba6f7">agmux dash</text>;
}
```

`packages/tui/src/opentui/SessionTable.tsx`:

```tsx
/** @jsxImportSource @opentui/react */
import type { SessionRow } from "@agmux/protocol";

export function SessionTable(props: {
  rows: SessionRow[]; selectedId: string | null; attachedId: string | null; now: number; height: number;
  onSelect: (id: string) => void;
}) {
  return <text>{props.rows.length} sessions</text>;
}
```

`packages/tui/src/opentui/PreviewPane.tsx`:

```tsx
/** @jsxImportSource @opentui/react */
import type { SessionRow, EventEnvelope } from "@agmux/protocol";
import type { PreviewMode, UsageSummary } from "../types.ts";

export function PreviewPane(props: {
  row: SessionRow | null; mode: PreviewMode; mirrorText: string;
  events: EventEnvelope[]; usage: UsageSummary | null; maxBodyLines: number;
}) {
  return <text>{props.row ? props.row.session_id : "no selection"}</text>;
}
```

`packages/tui/src/opentui/FooterBar.tsx`:

```tsx
/** @jsxImportSource @opentui/react */
export function FooterBar(props: { error: string | null; filtering: boolean; filter: string; confirmKill: string | null }) {
  return <text fg="#6c7086">j/k move · / filter · ⏎ attach · x kill · tab preview · ? help · q quit</text>;
}
```

- [ ] **Step 2: Full `DashApp` with feed + state + layout**

Replace `packages/tui/src/opentui/DashApp.tsx`:

```tsx
/** @jsxImportSource @opentui/react */
import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { LIVE_STATUSES, type SessionRow, type EventEnvelope } from "@agmux/protocol";
import type { SessionFeed } from "../feed.ts";
import type { Actions, Handoff, PreviewMode, PreviewSource, UsageSummary } from "../types.ts";
import { sortRows, nextSort, type SortKey } from "../shared/sort.ts";
import { filterRows } from "../shared/filter.ts";
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
  // best-effort attached session id (Task 15); null when unknown
  attachedId?: string | null;
}

const MODES: PreviewMode[] = ["mirror", "events", "detail"];

export function DashApp(props: DashAppProps) {
  const { feed, hubUrl } = props;

  const { width, height } = useTerminalDimensions();

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

  // Async-decoupled preview buffers (Task 13 fills the fetch effect).
  const [mirror] = useState<{ id: string | null; text: string }>({ id: null, text: "" });
  const [eventsBuf] = useState<{ id: string | null; list: EventEnvelope[] }>({ id: null, list: [] });
  const [usageBuf] = useState<{ id: string | null; data: UsageSummary | null }>({ id: null, data: null });

  const visible = useMemo(() => sortRows(filterRows(rows ?? [], filter), sortKey), [rows, filter, sortKey]);

  const effectiveSelectedId =
    selectedId && visible.some((r) => r.session_id === selectedId)
      ? selectedId
      : (visible[0]?.session_id ?? null);
  const selected = visible.find((r) => r.session_id === effectiveSelectedId) ?? null;

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
    if (showHelp) { if (key.name === "escape" || key.name === "q" || key.sequence === "?") setShowHelp(false); return; }

    if (key.name === "q") { props.onQuit(); return; }
    if (key.sequence === "?") { setShowHelp(true); return; }
    if (key.name === "j" || key.name === "down") { move(1); return; }
    if (key.name === "k" || key.name === "up") { move(-1); return; }
    if (key.name === "g") { setSelectedId(visible[0]?.session_id ?? null); return; }
    if (key.name === "G") { setSelectedId(visible[visible.length - 1]?.session_id ?? null); return; }
    if (key.sequence === "s") { setSortKey((k) => nextSort(k)); return; }
    if (key.name === "tab") { setMode((m) => MODES[(MODES.indexOf(m) + 1) % MODES.length]!); return; }
    if (key.sequence === "/") { setFilter(""); setFiltering(true); return; }
    if (key.name === "return" && selected) {
      void props.actions.attach(selected).then((h) => { if (h) { props.onHandoff(h); props.onQuit(); } });
      return;
    }
    if (key.sequence === "x" && selected && LIVE_STATUSES.includes(selected.status)) { setConfirmKill(selected); return; }
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
            : <SessionTable rows={visible} selectedId={effectiveSelectedId} attachedId={props.attachedId ?? null} now={now} height={bodyHeight} onSelect={setSelectedId} />}
        </box>
        <box style={{ width: "45%", border: true }} title={mode[0]!.toUpperCase() + mode.slice(1)}>
          <PreviewPane
            row={selected} mode={mode}
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
```

- [ ] **Step 3: Typecheck**

Run: `bun run --filter '@agmux/tui' typecheck`
Expected: PASS.

> If `useKeyboard`'s key object field names differ from `key.name` / `key.sequence` / `key.ctrl` / `key.meta` (confirm via the recorded Task 2 notes / `@opentui/react` types), adjust the handlers here and in Task 14's test accordingly.

- [ ] **Step 4: Commit**

```bash
git add packages/tui/src/opentui/
git commit -m "tui: DashApp feed wiring, state, layout skeleton"
```

---

## Task 11: `HeaderBar` — title, connection, status counts

**Files:**
- Modify: `packages/tui/src/opentui/HeaderBar.tsx`

- [ ] **Step 1: Implement**

```tsx
/** @jsxImportSource @opentui/react */
import type { SessionRow, SessionStatus } from "@agmux/protocol";

function count(rows: SessionRow[], s: SessionStatus[]): number {
  return rows.filter((r) => s.includes(r.status)).length;
}

export function HeaderBar(props: { rows: SessionRow[]; connected: boolean; hubUrl: string }) {
  const { rows } = props;
  return (
    <box style={{ flexDirection: "row", height: 1, justifyContent: "space-between", paddingLeft: 1, paddingRight: 1 }}>
      <text>
        <span fg="#cba6f7">agmux dash</span>
        {"  "}
        <span fg={props.connected ? "#89b4fa" : "#f38ba8"}>{props.connected ? "● connected" : "◌ reconnecting"}</span>
      </text>
      <text>
        <span fg="#6c7086">{rows.length} sessions  </span>
        <span fg="#f9e2af">{count(rows, ["waiting"])} input </span>
        <span fg="#a6e3a1">{count(rows, ["running"])} run </span>
        <span fg="#6c7086">{count(rows, ["idle"])} idle </span>
        <span fg="#585b70">{count(rows, ["ended", "lost"])} closed</span>
      </text>
    </box>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `bun run --filter '@agmux/tui' typecheck`
Expected: PASS.

> If `<span>` is not a valid intrinsic in the installed binding (react.mdx lists it under text modifiers), fall back to multiple adjacent `<text>` elements inside a `flexDirection: "row"` box. Confirm against the Task 2 frame output.

- [ ] **Step 3: Commit**

```bash
git add packages/tui/src/opentui/HeaderBar.tsx
git commit -m "tui: dash HeaderBar with status counts"
```

---

## Task 12: `SessionTable` — the hero table

Renders a header row + one styled line per session inside a `<scrollbox>`, with the leading glyph, gutter marker (`▶` selected / `◆` attached), and colored, padded columns. Each row is an `onMouseDown` target that selects it (mouse click-to-select); the `<scrollbox>` provides mouse-wheel scrolling natively. Keeps the selected row scrolled into view with `scrollChildIntoView` by row id.

**Files:**
- Modify: `packages/tui/src/opentui/SessionTable.tsx`

- [ ] **Step 1: Implement**

```tsx
/** @jsxImportSource @opentui/react */
import { useEffect, useMemo, useRef } from "react";
import type { SessionRow } from "@agmux/protocol";
import { COLS, columnWidths, pad, rowCells, type RowCells } from "../shared/columns.ts";
import { statusGlyph } from "../shared/glyph.ts";

export function SessionTable(props: {
  rows: SessionRow[]; selectedId: string | null; attachedId: string | null; now: number; height: number;
  onSelect: (id: string) => void;
}) {
  const { rows, selectedId, attachedId, now } = props;

  const cells = useMemo<RowCells[]>(() => rows.map((r) => rowCells(r, now)), [rows, now]);
  const widths = useMemo(() => columnWidths(cells), [cells]);

  const headerText = useMemo(
    () => "   " + COLS.map((c) => pad(c.header, widths[c.key], "left")).join("  "),
    [widths],
  );

  // Keep the selected row visible without moving the viewport more than needed.
  const boxRef = useRef<any>(null);
  useEffect(() => {
    if (selectedId && boxRef.current?.scrollChildIntoView) {
      boxRef.current.scrollChildIntoView(`row-${selectedId}`);
    }
  }, [selectedId]);

  return (
    <box style={{ flexDirection: "column", flexGrow: 1 }}>
      <text fg="#9399b2" attributes={1 /* DIM placeholder; replace with TextAttributes.DIM in Step 2 */}>{headerText}</text>
      <scrollbox ref={boxRef} style={{ flexGrow: 1 }} scrollY stickyScroll={false}>
        {rows.map((r, i) => {
          const g = statusGlyph(r);
          const c = cells[i]!;
          const isSel = r.session_id === selectedId;
          const isAtt = r.session_id === attachedId;
          const gutter = isSel ? "▶" : isAtt ? "◆" : " ";
          const gutterColor = isSel ? "#ffffff" : isAtt ? "#94e2d5" : "#6c7086";
          return (
            <box key={r.session_id} id={`row-${r.session_id}`} onMouseDown={() => props.onSelect(r.session_id)} style={{ flexDirection: "row", backgroundColor: isSel ? "#313244" : undefined }}>
              <text fg={gutterColor}>{gutter} </text>
              <text fg={g.color}>{g.glyph} </text>
              <text fg={isSel ? "#ffffff" : "#9399b2"}>{pad(c.id, widths.id, "left")}  </text>
              <text fg={isSel ? "#ffffff" : "#89b4fa"}>{pad(c.tmux, widths.tmux, "left")}  </text>
              <text fg={isSel ? "#ffffff" : "#cdd6f4"}>{pad(c.agent, widths.agent, "left")}  </text>
              <text fg={isSel ? "#ffffff" : "#cdd6f4"}>{pad(c.profile, widths.profile, "left")}  </text>
              <text fg={isSel ? "#ffffff" : "#cdd6f4"}>{pad(c.turns, widths.turns, "right")}  </text>
              <text fg={isSel ? "#ffffff" : "#cdd6f4"}>{pad(c.last, widths.last, "right")}</text>
            </box>
          );
        })}
      </scrollbox>
    </box>
  );
}
```

- [ ] **Step 2: Replace the DIM placeholder with the real attribute**

Change the header `<text>` line to import and use the real attribute:

```tsx
import { TextAttributes } from "@opentui/core";
// ...
<text fg="#9399b2" attributes={TextAttributes.DIM}>{headerText}</text>
```

(Add `TextAttributes` to the existing `@opentui/core` import line.)

- [ ] **Step 3: Typecheck**

Run: `bun run --filter '@agmux/tui' typecheck`
Expected: PASS. If `ref`/`id`/`scrollChildIntoView` typings are unavailable on the JSX `<scrollbox>`, type `boxRef` as `any` (already done) and keep the guarded optional call.

- [ ] **Step 4: Commit**

```bash
git add packages/tui/src/opentui/SessionTable.tsx
git commit -m "tui: dash SessionTable (glyph-first columns, markers, mouse-select, scroll-into-view)"
```

---

## Task 13: `PreviewPane` — tabbed, mode-keyed body

Render the existing three preview modes. The body is a single switch keyed by `mode`, so the future detail-card + last-agent-message view is a drop-in new branch behind the same props.

**Files:**
- Modify: `packages/tui/src/opentui/PreviewPane.tsx`

- [ ] **Step 1: Implement**

```tsx
/** @jsxImportSource @opentui/react */
import type { SessionRow, EventEnvelope } from "@agmux/protocol";
import type { PreviewMode, UsageSummary } from "../types.ts";

function header(row: SessionRow): string {
  return `${row.session_id.slice(0, 13)} · ${row.agent_kind}${row.profile ? ` · ${row.profile}` : ""}`;
}

function Body(props: {
  row: SessionRow; mode: PreviewMode; mirrorText: string; events: EventEnvelope[]; usage: UsageSummary | null; maxBodyLines: number;
}) {
  if (props.mode === "mirror") {
    const lines = props.mirrorText ? props.mirrorText.split("\n").slice(-props.maxBodyLines) : [];
    if (lines.length === 0) return <text fg="#6c7086">no mirror output</text>;
    return <text>{lines.join("\n")}</text>;
  }
  if (props.mode === "events") {
    const lines = props.events.slice(-props.maxBodyLines).map((e) => `${e.ts?.slice(11, 19) ?? ""} ${e.type}`);
    if (lines.length === 0) return <text fg="#6c7086">no events</text>;
    return <text>{lines.join("\n")}</text>;
  }
  // detail
  const u = props.usage;
  return (
    <box style={{ flexDirection: "column" }}>
      <text>status: {props.row.status}</text>
      <text>turns: {props.row.turn_count ?? "-"}</text>
      {u ? <text>tokens: {u.input_tokens}/{u.output_tokens}  cost: ${u.cost_usd.toFixed(4)}</text> : <text fg="#6c7086">no usage</text>}
    </box>
  );
}

export function PreviewPane(props: {
  row: SessionRow | null; mode: PreviewMode; mirrorText: string;
  events: EventEnvelope[]; usage: UsageSummary | null; maxBodyLines: number;
}) {
  if (!props.row) return <text fg="#6c7086">no selection</text>;
  return (
    <box style={{ flexDirection: "column", flexGrow: 1 }}>
      <text fg="#6c7086">{header(props.row)}</text>
      <text fg="#45475a">{"─".repeat(20)}</text>
      <Body row={props.row} mode={props.mode} mirrorText={props.mirrorText} events={props.events} usage={props.usage} maxBodyLines={props.maxBodyLines} />
    </box>
  );
}
```

- [ ] **Step 2: Confirm `EventEnvelope` field names**

Run: `grep -n "ts\|type\|interface EventEnvelope" packages/protocol/src/events.ts | head`
Expected: confirm the envelope has a timestamp field and `type`. If the field is not `ts`, update the `events` branch mapping accordingly.

- [ ] **Step 3: Typecheck**

Run: `bun run --filter '@agmux/tui' typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/tui/src/opentui/PreviewPane.tsx
git commit -m "tui: dash PreviewPane (mode-keyed body for future detail view)"
```

---

## Task 14: `FooterBar` — hints, filter line, kill confirm

**Files:**
- Modify: `packages/tui/src/opentui/FooterBar.tsx`

- [ ] **Step 1: Implement**

```tsx
/** @jsxImportSource @opentui/react */
const HINT = "j/k move · g/G top/bottom · s sort · / filter · ⏎ attach · x kill · tab preview · ? help · q quit";

export function FooterBar(props: { error: string | null; filtering: boolean; filter: string; confirmKill: string | null }) {
  if (props.confirmKill) return <text fg="#f38ba8">kill {props.confirmKill}? y/n</text>;
  if (props.filtering) return <text>filter: {props.filter}▏</text>;
  if (props.error) return <text fg="#f38ba8">hub unreachable — reconnecting… ({props.error})</text>;
  return <text fg="#6c7086">{HINT}</text>;
}
```

- [ ] **Step 2: Typecheck + smoke-run the app manually (optional but recommended)**

Run: `bun run --filter '@agmux/tui' typecheck`
Expected: PASS.

(Full manual run happens in Task 17 once the CLI flag is wired.)

- [ ] **Step 3: Commit**

```bash
git add packages/tui/src/opentui/FooterBar.tsx
git commit -m "tui: dash FooterBar (hints/filter/kill-confirm)"
```

---

## Task 15: Best-effort attached-session detection

When dash runs inside tmux, mark the session whose pane matches the active pane of the parent client. If detection fails, return `null` (gutter stays blank — never blocks).

**Files:**
- Create: `packages/tui/src/opentui/attached.ts`
- Test: `packages/tui/tests/opentui/attached.test.ts`
- Modify: `packages/tui/src/opentui/run-manage-otui.tsx` (compute once, pass to `DashApp`)

- [ ] **Step 1: Write the failing test**

```typescript
import { test, expect } from "bun:test";
import { matchAttachedPane } from "../../src/opentui/attached.ts";
import { mkRow } from "../helpers/mk-row.ts";

test("matches the row whose tmux_pane equals the active pane", () => {
  const rows = [mkRow({ session_id: "a", tmux_pane: "%3" }), mkRow({ session_id: "b", tmux_pane: "%5" })];
  expect(matchAttachedPane(rows, "%5")).toBe("b");
});
test("no active pane → null", () => {
  expect(matchAttachedPane([mkRow({ tmux_pane: "%3" })], null)).toBeNull();
});
test("no matching pane → null", () => {
  expect(matchAttachedPane([mkRow({ tmux_pane: "%3" })], "%9")).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/tui/tests/opentui/attached.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
import type { SessionRow } from "@agmux/protocol";

// Pure matcher: which session id (if any) owns the given active pane.
export function matchAttachedPane(rows: SessionRow[], activePane: string | null): string | null {
  if (!activePane) return null;
  return rows.find((r) => r.tmux_pane === activePane)?.session_id ?? null;
}

// Side-effecting probe: the active pane of the parent client, or null when not in
// tmux / on any failure. tmux `#{pane_id}` of the active pane in the attached client.
export async function activePaneId(
  runTmux: (args: string[]) => Promise<string> = defaultTmuxText,
): Promise<string | null> {
  if (!process.env.TMUX) return null;
  try {
    const out = await runTmux(["display-message", "-p", "#{pane_id}"]);
    const id = out.trim();
    return id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

const defaultTmuxText = async (args: string[]): Promise<string> => {
  const proc = Bun.spawn(["tmux", ...args], { stdout: "pipe", stderr: "ignore" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  if (proc.exitCode !== 0) throw new Error(`tmux exit ${proc.exitCode}`);
  return out;
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/tui/tests/opentui/attached.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Wire into the entry**

In `run-manage-otui.tsx`, after creating the feed and before `createRoot`, resolve the active pane once and pass it down. Since `DashApp` recomputes `attachedId` from live rows, pass the raw active pane and let the app match it. Simplest: compute `attachedId` reactively inside `DashApp` from a prop `activePane`. Update the entry:

```tsx
import { activePaneId } from "./attached.ts";
// ...
const activePane = await activePaneId();
// ...in the JSX:
//   <DashApp ... activePane={activePane} />
```

And in `DashApp.tsx`, replace the `attachedId` prop usage: add `activePane?: string | null` to `DashAppProps`, import `matchAttachedPane`, and compute:

```tsx
import { matchAttachedPane } from "./attached.ts";
// inside component, after `visible`:
const attachedId = useMemo(() => matchAttachedPane(visible, props.activePane ?? null), [visible, props.activePane]);
// pass attachedId to <SessionTable attachedId={attachedId} .../> (replace props.attachedId)
```

Remove the now-unused `attachedId` prop from `DashAppProps`.

- [ ] **Step 6: Typecheck**

Run: `bun run --filter '@agmux/tui' typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/tui/src/opentui/attached.ts packages/tui/tests/opentui/attached.test.ts packages/tui/src/opentui/run-manage-otui.tsx packages/tui/src/opentui/DashApp.tsx
git commit -m "tui: best-effort attached-session marker"
```

---

## Task 16: Async-decoupled preview fetch

Port the debounced + tagged-buffer preview fetch from `manage-app.tsx` so navigation stays instant while the preview lands asynchronously.

**Files:**
- Modify: `packages/tui/src/opentui/DashApp.tsx`

- [ ] **Step 1: Replace the placeholder buffer state with real fetch**

In `DashApp.tsx`, replace the three placeholder `useState` buffer lines with live state + an effect. Add imports `useEffect`, and `LIVE_STATUSES` is already imported.

```tsx
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
```

Then change the `<PreviewPane ... mode={mode}` prop to `mode={effectiveMode}` and the box `title` to use `effectiveMode`.

- [ ] **Step 2: Typecheck**

Run: `bun run --filter '@agmux/tui' typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/tui/src/opentui/DashApp.tsx
git commit -m "tui: async-decoupled preview fetch (debounce + tagged buffers)"
```

---

## Task 17: Wire the CLI flag + export

**Files:**
- Modify: `packages/tui/src/index.ts`
- Modify: `packages/cli/src/dash.ts`

- [ ] **Step 1: Export the OpenTUI entry**

Add to `packages/tui/src/index.ts`:

```typescript
export { runManageOtui } from "./opentui/run-manage-otui.tsx";
```

- [ ] **Step 2: Branch in the CLI**

Edit `packages/cli/src/dash.ts`. Add the import and a `tui` selector dep:

```typescript
import { runManage, runManageOtui, type RunManageOpts, type PreviewSource, type Actions } from "@agmux/tui";
```

Extend `DashCmdDeps` and `defaultDeps`:

```typescript
export interface DashCmdDeps {
  isTTY: () => boolean;
  runManageImpl: (o: RunManageOpts) => Promise<number>;
  runManageOtuiImpl: (o: RunManageOpts) => Promise<number>;
  tuiKind: () => string | undefined;
  makeSourceImpl: (hubUrl: string) => PreviewSource;
  makeActionsImpl: (hubUrl: string, wrapBin: string, popup: boolean) => Actions;
  errOut: (s: string) => void;
}

const defaultDeps: DashCmdDeps = {
  isTTY: () => Boolean(process.stdout.isTTY && process.stdin.isTTY),
  runManageImpl: runManage,
  runManageOtuiImpl: runManageOtui,
  tuiKind: () => process.env.AGMUX_TUI,
  makeSourceImpl: makePreviewSource,
  makeActionsImpl: makeActions,
  errOut: (s) => console.error(s),
};
```

In `dashCmd`, choose the implementation:

```typescript
  const run = deps.tuiKind() === "opentui" ? deps.runManageOtuiImpl : deps.runManageImpl;
  return run({
    hubUrl: opts.hubUrl,
    query: buildLsQuery(opts),
    intervalMs: opts.intervalMs,
    defaultPreview: opts.preview,
    source: deps.makeSourceImpl(opts.hubUrl),
    actions: deps.makeActionsImpl(opts.hubUrl, opts.wrapBin, opts.popup),
  });
```

- [ ] **Step 3: Typecheck both packages**

Run: `bun run --filter '@agmux/tui' typecheck && bun run --filter '@agmux/cli' typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/tui/src/index.ts packages/cli/src/dash.ts
git commit -m "cli: select dash TUI via AGMUX_TUI env (ink default, opentui opt-in)"
```

---

## Task 18: Render + interaction smoke test

**Files:**
- Create: `packages/tui/tests/opentui/dash-app.test.tsx`

- [ ] **Step 1: Write the smoke test (uses `testRender` + `act` — see Confirmed API)**

First read `node_modules/@opentui/react/test-utils*` (`.d.ts` and source) to confirm `testRender`'s exact signature and return shape, then write the test. The shape below matches the verified 0.4.1 behavior (`testRender` wraps `createTestRenderer` + `act`); adjust property names if the declaration differs.

```tsx
/** @jsxImportSource @opentui/react */
import { test, expect } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import type { SessionRow, EventEnvelope } from "@agmux/protocol";
import type { SessionFeed } from "../../src/feed.ts";
import type { Actions, PreviewSource, UsageSummary } from "../../src/types.ts";
import { DashApp } from "../../src/opentui/DashApp.tsx";
import { mkRow } from "../helpers/mk-row.ts";

function fakeFeed(rows: SessionRow[]): SessionFeed {
  return { subscribe(onUpdate) { onUpdate(rows); return () => {}; } };
}
const noSource: PreviewSource = {
  async mirror() { return ""; },
  async events(): Promise<EventEnvelope[]> { return []; },
  async usage(): Promise<UsageSummary | null> { return null; },
};
const noActions: Actions = {
  async attach() { return null; },
  async kill() {},
  async resume() { return { argv: [] }; },
};

test("renders the table and j/k moves the selection", async () => {
  const rows = [
    mkRow({ session_id: "agx-aaaaaaaa1", status: "waiting", tmux_session: "main", tmux_window: "w1" }),
    mkRow({ session_id: "agx-bbbbbbbb2", status: "running", tmux_session: "work", tmux_window: "w2" }),
  ];
  // testRender handles act() around the initial render and returns the test harness.
  const { renderer, renderOnce, captureCharFrame, mockInput } = await testRender(
    <DashApp
      feed={fakeFeed(rows)} source={noSource} actions={noActions}
      hubUrl="http://localhost:0" defaultPreview="mirror" intervalMs={1000}
      onHandoff={() => {}} onQuit={() => {}}
    />,
    { width: 120, height: 30 },
  );
  await renderOnce();

  const frame1 = captureCharFrame();
  expect(frame1).toContain("Sessions");
  expect(frame1).toContain("agx-aaaaaaaa1");
  expect(frame1).toContain("agx-bbbbbbbb2");
  // first row (waiting, status sort) is selected → cursor on row 1
  const sel1 = frame1.split("\n").find((l) => l.includes("▶"));
  expect(sel1).toContain("agx-aaaaaaaa1");

  await act(async () => { mockInput.pressKey("j"); });
  await renderOnce();
  const frame2 = captureCharFrame();
  const sel2 = frame2.split("\n").find((l) => l.includes("▶"));
  expect(sel2).toContain("agx-bbbbbbbb2");

  renderer.destroy();
});
```

- [ ] **Step 2: Run the test**

Run: `bun test packages/tui/tests/opentui/dash-app.test.tsx`
Expected: PASS. If `testRender`'s return shape or args differ from above, fix per the `.d.ts` you read. If the cursor glyph isn't found, raise `width` and confirm the `▶` gutter renders for the selected row.

- [ ] **Step 3: Commit**

```bash
git add packages/tui/tests/opentui/dash-app.test.tsx
git commit -m "tui: opentui dash render + nav smoke test"
```

---

## Task 19: Full suite + manual verification

**Files:** none (verification only)

- [ ] **Step 1: Run the whole TUI test suite**

Run: `bun test packages/tui`
Expected: PASS — all new `shared/` + `opentui/` tests green AND the existing Ink tests (`manage-app.test.tsx`, `preview.test.tsx`, `group-table.test.ts`, etc.) still green.

- [ ] **Step 2: Typecheck the workspace**

Run: `bun run typecheck`
Expected: PASS for all packages.

- [ ] **Step 3: Manual A/B against a live hub**

With a hub running and at least one live session:

```bash
# current Ink dash (baseline)
agmux dash
# new OpenTUI dash
AGMUX_TUI=opentui agmux dash
```

Verify in the OpenTUI dash:
- Distinct bordered panels, color-coded glyphs (amber/green/grey/red/muted), header counts.
- `j`/`k`/`g`/`G` navigation feels instant (no lag), even while a running session's mirror updates.
- `tab` cycles mirror/events/detail; `/` filters; `s` cycles sort.
- Mouse: clicking a row selects it; wheel scrolls the table.
- `⏎` attaches to a live session end-to-end.
- `x` then `y` kills; `q` quits and the terminal is fully restored (no leftover alt-screen/mouse mode).

Record the verdict (smooth + on-target UX, or gaps) in the spec's "Success criteria" section.

- [ ] **Step 4: Verify the compiled binary**

Run: `bun run --filter '@agmux/cli' build`
Then: `AGMUX_TUI=opentui packages/cli/dist/agmux dash`
Expected: the standalone compiled binary launches the OpenTUI dash (confirms `@opentui` native core packages into `bun build --compile`). If it fails to load the native library, note it as a packaging follow-up in the spec risks.

- [ ] **Step 5: Commit any verification notes**

```bash
git add docs/superpowers/specs/2026-06-20-opentui-dash-spike-design.md
git commit -m "docs: record opentui dash spike verification verdict"
```

---

## Confirmed OpenTUI 0.4.1 API (verified in Task 2 — authoritative)

The installed version is **`@opentui/core`/`@opentui/react` 0.4.1** (newer than the docs). Verified facts to build against:

- **`<box>`**: layout/visual options (`border`, `borderStyle`, `flexDirection`, `flexGrow`, `width`, `height`, `padding`, `backgroundColor`) work as direct props **or** under `style` — both fine. **`title`/`bottomTitle` must be DIRECT props** (excluded from `style`). `onMouseDown` is a valid direct prop.
- **`<text>`**: `fg`/`bg` direct (or via `style`). `attributes={TextAttributes.DIM}` works; `TextAttributes` is exported from `@opentui/core`.
- **`<span>`**: valid inside `<text>`, takes `fg`/`bg`/`attributes` — the supported way to color inline segments.
- **`<scrollbox>`**: `scrollY`/`stickyScroll` are direct props; a `ref` exposes `scrollChildIntoView(id: string)`; children accept `id` and `onMouseDown`.
- **`useKeyboard((key) => …)`** event fields: `key.name`, `key.sequence`, `key.ctrl`, `key.meta`, `key.shift`. `name` values: Enter=`"return"`, Esc=`"escape"`, Backspace=`"backspace"`, Tab=`"tab"`, arrows=`"up"/"down"/"left"/"right"`, plain letters/symbols are themselves (`"j"`, `"s"`, `"/"`, `"?"`, `"x"`, `"y"`, `"g"`), Shift+G=`"G"` with `shift:true`. **Prefer `key.name` consistently** (the plan's occasional `key.sequence === "x"` also works, but standardize on `key.name`).
- **App entry (non-test):** `createRoot(renderer).render(<App/>)` is correct (Task 9).
- **Tests:** use **`testRender`** from `@opentui/react/test-utils` (it wraps `createTestRenderer` + `act()` + sets `IS_REACT_ACT_ENVIRONMENT`); raw `createTestRenderer`+`createRoot` renders a blank frame. Wrap input that triggers state in React's `act()`. `mockInput` methods: `pressKey("j")`, `pressKey("G", { shift: true })`, `pressEnter()`, `pressEscape()` (needs `kittyKeyboard: true`), `pressArrow("down")`, `typeText(...)`. `captureCharFrame()` + `renderOnce()` are available. Confirm `testRender`'s exact return shape from `node_modules/@opentui/react/test-utils*.d.ts`.

## Notes for the implementer

- **JSX pragma:** every `.tsx` under `src/opentui/` and the smoke test starts with `/** @jsxImportSource @opentui/react */`. Ink files keep using the package-level `react-jsx`. Do not change `packages/tui/tsconfig.json`.
- **Don't touch the Ink path** (`run-manage.tsx`, `manage-app.tsx`, `session-list.tsx`, `preview.tsx`, `group-table.ts`, `keymap.ts`) — it stays the default and the regression baseline.
- **API confirmations (Task 2)** gate the component code: if `useKeyboard` key fields, `<span>`, `<scrollbox>` ref methods, or `mockInput` differ from this plan's assumptions, adjust the affected task inline.
- **DRY/YAGNI:** the `shared/` modules are the single source of truth for cell formatting/sort/filter/glyph — the future full cutover reuses them and deletes the Ink-specific `group-table.ts`/`format.ts` duplicates.
