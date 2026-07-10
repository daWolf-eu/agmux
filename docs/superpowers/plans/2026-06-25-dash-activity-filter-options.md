# dash activity-group filter + resume-on-closed — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a runtime activity-group filter (`open` / `closed` / `all`) to `agmux dash`, and make Enter on a closed session gracefully resume it into a new window of the tmux session dash runs in.

**Architecture:** The dash already filters and sorts client-side over rows polled from the hub. We switch the dash to fetch *all* statuses (the hub returns all when `status` is omitted) and add a client-side activity-group filter cycled with `f`. The existing free-text `/` match is renamed "search" to disambiguate. Pressing Enter dispatches on status: live → `attach` (unchanged), terminal → `resume`. Resume places the relaunched agent in a new window of the caller's tmux session (creating it only when dash runs outside tmux) and switches the client onto it.

**Tech Stack:** Bun, TypeScript, React via `@opentui/react` (TUI), `bun test` (with `@opentui/react/test-utils` for TUI render tests), tmux CLI.

## Global Constraints

- Runtime is **Bun ≥ 1.3** only; no Node.js fallback. Tests use `bun:test`.
- TUI package (`@agmux/tui`) must not import `@agmux/store` types; it depends only on `@agmux/protocol` types.
- Status vocabulary is fixed in `@agmux/protocol`: `LIVE_STATUSES = [idle, running, waiting]`, `TERMINAL_STATUSES = [ended, lost]`, `STATUS_GROUPS = { active, open, closed }`.
- The `Handoff` contract: a non-empty `argv` is spawned after the renderer tears down; an empty `argv` (`{ argv: [] }`) is the exit sentinel (popup-mode retargets the client inline, then exits and spawns nothing); returning `null` means "handled inline, keep the TUI alive".
- Follow existing file/style conventions; keep files focused.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `packages/tui/src/shared/group.ts` (new) | `ActivityGroup` type, `inGroup`/`groupRows`/`nextGroup`, `initialGroup` derivation |
| `packages/tui/src/shared/search.ts` (renamed from `filter.ts`) | free-text match: `matchesSearch`/`searchRows` |
| `packages/tui/src/index.ts` | re-export the new group helpers + `ActivityGroup` type |
| `packages/tui/src/types.ts` | `Actions.resume` return type → `Handoff \| null` |
| `packages/tui/src/opentui/HeaderBar.tsx` | counts over all fetched rows + active-group indicator |
| `packages/tui/src/opentui/FooterBar.tsx` | hint wording + transient `notice` line |
| `packages/tui/src/opentui/DashApp.tsx` | `group` state + `f` key, search rename, status-aware Enter, `notice`, `initialGroup` prop |
| `packages/tui/src/opentui/run-manage.tsx` | thread `initialGroup` into `DashApp` |
| `packages/cli/src/dash-actions.ts` | `resumeIntoSession` placement + `makeActions.resume` rewrite |
| `packages/cli/src/dash.ts` | derive `initialGroup`, strip `status` from the hub query, pass through |

Test files (mirroring the above): `packages/tui/tests/shared/group.test.ts`, `packages/tui/tests/shared/search.test.ts` (renamed), `packages/tui/tests/opentui/dash-app.test.tsx`, `packages/cli/tests/dash-actions.test.ts`, `packages/cli/tests/dash.test.ts`.

---

## Task 1: Activity-group logic (`shared/group.ts`)

**Files:**
- Create: `packages/tui/src/shared/group.ts`
- Create: `packages/tui/tests/shared/group.test.ts`
- Modify: `packages/tui/src/index.ts`

**Interfaces:**
- Consumes: `@agmux/protocol` — `LIVE_STATUSES`, `TERMINAL_STATUSES`, `expandStatusFilter`, types `SessionRow`, `SessionStatus`.
- Produces:
  - `type ActivityGroup = "open" | "closed" | "all"`
  - `const GROUPS: ActivityGroup[]`
  - `inGroup(r: SessionRow, g: ActivityGroup): boolean`
  - `groupRows(rows: SessionRow[], g: ActivityGroup): SessionRow[]`
  - `nextGroup(g: ActivityGroup): ActivityGroup` (cycles `open → closed → all → open`)
  - `initialGroup(status?: string): ActivityGroup`

- [ ] **Step 1: Write the failing test**

Create `packages/tui/tests/shared/group.test.ts`:

```ts
import { test, expect } from "bun:test";
import { inGroup, groupRows, nextGroup, initialGroup, GROUPS } from "../../src/shared/group.ts";
import { mkRow } from "../helpers/mk-row.ts";

test("inGroup: open matches live, closed matches terminal, all matches everything", () => {
  const running = mkRow({ status: "running" });
  const ended = mkRow({ status: "ended" });
  expect(inGroup(running, "open")).toBe(true);
  expect(inGroup(ended, "open")).toBe(false);
  expect(inGroup(ended, "closed")).toBe(true);
  expect(inGroup(running, "closed")).toBe(false);
  expect(inGroup(running, "all")).toBe(true);
  expect(inGroup(ended, "all")).toBe(true);
});

test("groupRows keeps only rows in the group", () => {
  const rows = [mkRow({ session_id: "a", status: "running" }), mkRow({ session_id: "b", status: "lost" })];
  expect(groupRows(rows, "open").map((r) => r.session_id)).toEqual(["a"]);
  expect(groupRows(rows, "closed").map((r) => r.session_id)).toEqual(["b"]);
  expect(groupRows(rows, "all").map((r) => r.session_id)).toEqual(["a", "b"]);
});

test("nextGroup cycles open -> closed -> all -> open", () => {
  expect(nextGroup("open")).toBe("closed");
  expect(nextGroup("closed")).toBe("all");
  expect(nextGroup("all")).toBe("open");
  expect(GROUPS).toEqual(["open", "closed", "all"]);
});

test("initialGroup derives the starting group from a status string", () => {
  expect(initialGroup(undefined)).toBe("open");
  expect(initialGroup("open")).toBe("open");
  expect(initialGroup("active")).toBe("open");
  expect(initialGroup("closed")).toBe("closed");
  expect(initialGroup("ended,lost")).toBe("closed");
  expect(initialGroup("idle,running")).toBe("open");
  expect(initialGroup("running,ended")).toBe("all"); // mixed live+terminal
  expect(initialGroup("nonsense")).toBe("all");      // unparseable -> all
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/tui/tests/shared/group.test.ts`
Expected: FAIL — cannot resolve `../../src/shared/group.ts`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/tui/src/shared/group.ts`:

```ts
import {
  LIVE_STATUSES, TERMINAL_STATUSES, expandStatusFilter,
  type SessionRow,
} from "@agmux/protocol";

// The dash's activity-group filter (key `f`), distinct from the free-text
// "search" (key `/`). "open" = live, "closed" = terminal, "all" = no filter.
export type ActivityGroup = "open" | "closed" | "all";
export const GROUPS: ActivityGroup[] = ["open", "closed", "all"];

export function inGroup(r: SessionRow, g: ActivityGroup): boolean {
  if (g === "all") return true;
  if (g === "open") return LIVE_STATUSES.includes(r.status);
  return TERMINAL_STATUSES.includes(r.status);
}

export function groupRows(rows: SessionRow[], g: ActivityGroup): SessionRow[] {
  return rows.filter((r) => inGroup(r, g));
}

export function nextGroup(g: ActivityGroup): ActivityGroup {
  return GROUPS[(GROUPS.indexOf(g) + 1) % GROUPS.length]!;
}

// Map a resolved `--status`/config value to the dash's starting group. The dash
// fetches all statuses; this only picks the initial view (default "open").
export function initialGroup(status?: string): ActivityGroup {
  if (!status) return "open";
  const expanded = expandStatusFilter(status);
  if (!expanded || expanded.length === 0) return "all";
  if (expanded.every((s) => TERMINAL_STATUSES.includes(s))) return "closed";
  if (expanded.every((s) => LIVE_STATUSES.includes(s))) return "open";
  return "all";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/tui/tests/shared/group.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Export from the tui index**

Modify `packages/tui/src/index.ts` — add this line after the existing exports:

```ts
export { type ActivityGroup, GROUPS, inGroup, groupRows, nextGroup, initialGroup } from "./shared/group.ts";
```

- [ ] **Step 6: Typecheck and commit**

Run: `bun run --filter @agmux/tui typecheck`
Expected: no errors.

```bash
git add packages/tui/src/shared/group.ts packages/tui/tests/shared/group.test.ts packages/tui/src/index.ts
git commit -m "tui: activity-group filter logic (open/closed/all)"
```

---

## Task 2: Rename free-text filter → "search"

**Files:**
- Rename: `packages/tui/src/shared/filter.ts` → `packages/tui/src/shared/search.ts`
- Rename: `packages/tui/tests/shared/filter.test.ts` → `packages/tui/tests/shared/search.test.ts`
- Modify: `packages/tui/src/opentui/DashApp.tsx:8,61` (import + call sites)

**Interfaces:**
- Produces: `matchesSearch(r: SessionRow, q: string): boolean`, `searchRows(rows: SessionRow[], q: string): SessionRow[]` (same behavior as the old `matchesFilter`/`filterRows`).

This is a pure rename — the `f` key/group filter is added later. Behavior is unchanged; only names change so "search" (`/`) and "filter" (`f`) stop colliding.

- [ ] **Step 1: Create the renamed module**

Create `packages/tui/src/shared/search.ts`:

```ts
import type { SessionRow } from "@agmux/protocol";

// Free-text match behind the dash's `/` key. Matches across identifying fields.
export function matchesSearch(r: SessionRow, q: string): boolean {
  if (!q) return true;
  const n = q.toLowerCase();
  return [r.session_id, r.agent_kind, r.profile ?? "", r.tmux_session ?? "", r.tmux_window ?? "", r.status]
    .some((s) => s.toLowerCase().includes(n));
}

export function searchRows(rows: SessionRow[], q: string): SessionRow[] {
  return rows.filter((r) => matchesSearch(r, q));
}
```

- [ ] **Step 2: Delete the old module and rename its test**

```bash
git rm packages/tui/src/shared/filter.ts
git mv packages/tui/tests/shared/filter.test.ts packages/tui/tests/shared/search.test.ts
```

- [ ] **Step 3: Update the renamed test**

Replace the import and symbol names in `packages/tui/tests/shared/search.test.ts`. The file's first lines become:

```ts
import { test, expect } from "bun:test";
import { matchesSearch, searchRows } from "../../src/shared/search.ts";
```

Then replace every `matchesFilter` with `matchesSearch` and every `filterRows` with `searchRows` in that file (the assertions and expected values are unchanged).

- [ ] **Step 4: Update DashApp import + call site**

In `packages/tui/src/opentui/DashApp.tsx`:

Change line 8 from:
```ts
import { filterRows } from "../shared/filter.ts";
```
to:
```ts
import { searchRows } from "../shared/search.ts";
```

Change line 61 from:
```ts
  const visible = useMemo(() => sortRows(filterRows(rows ?? [], filter), sortKey), [rows, filter, sortKey]);
```
to (interim — `filter` state is renamed in Task 4; keep it compiling now):
```ts
  const visible = useMemo(() => sortRows(searchRows(rows ?? [], filter), sortKey), [rows, filter, sortKey]);
```

- [ ] **Step 5: Run tests + typecheck**

Run: `bun test packages/tui/tests/shared/search.test.ts && bun run --filter @agmux/tui typecheck`
Expected: PASS; no type errors.

- [ ] **Step 6: Commit**

```bash
git add packages/tui/src/shared/search.ts packages/tui/tests/shared/search.test.ts packages/tui/src/opentui/DashApp.tsx
git commit -m "tui: rename free-text filter to search (disambiguate from f filter)"
```

---

## Task 3: Resume placement into the caller's session

**Files:**
- Modify: `packages/cli/src/dash-actions.ts` (replace `resumeIntoNewWindow`, rewrite `makeActions.resume`)
- Modify: `packages/tui/src/types.ts:37` (`Actions.resume` return type)
- Modify: `packages/cli/tests/dash-actions.test.ts` (replace the `resumeIntoNewWindow` test)

**Interfaces:**
- Consumes: from `./tmux-place.ts` — `hasSession`, `newWindow`, `newSession`, `switchClient`, `readCurrentPane`, `type PaneCoords`; from `./relaunch.ts` — `buildRelaunchSpec`, `type RelaunchSpec`; `Handoff` from `@agmux/tui`.
- Produces:
  - `interface ResumePlacementDeps { hasSession; newWindow; newSession; switchClient }`
  - `resumeIntoSession(spec: RelaunchSpec, targetSession: string, label: string, deps?: ResumePlacementDeps): Promise<Handoff>` — places the agent in a new window of `targetSession` (creating the session via `newSession` only if it does not exist), switches the client onto it, returns the exit sentinel `{ argv: [] }`.
  - `makeActions(...).resume(row): Promise<Handoff | null>` — outside tmux → `{ argv: wrapArgv, env }`; popup → `{ argv: [] }`; inline tmux → `null`.

- [ ] **Step 1: Loosen the `Actions.resume` type**

In `packages/tui/src/types.ts`, change line 37 from:
```ts
  resume(row: SessionRow): Promise<Handoff>;
```
to:
```ts
  resume(row: SessionRow): Promise<Handoff | null>;
```

- [ ] **Step 2: Write the failing test**

In `packages/cli/tests/dash-actions.test.ts`, **remove** the existing `resumeIntoNewWindow ...` test (lines 25-39) and its import of `resumeIntoNewWindow`. Update the import line at the top to:

```ts
import { attachInPopup, resumeIntoSession, type ResumePlacementDeps } from "../src/dash-actions.ts";
```

Then append these tests:

```ts
function placementSpy(exists: boolean) {
  const calls: { newWindow: any[]; newSession: any[]; switched: string[] } = { newWindow: [], newSession: [], switched: [] };
  const deps: ResumePlacementDeps = {
    hasSession: async () => exists,
    newWindow: async (a: any) => { calls.newWindow.push(a); return { session: a.sessionName, window: "@7", pane: "%7" }; },
    newSession: async (a: any) => { calls.newSession.push(a); return { session: a.sessionName, window: "@1", pane: "%1" }; },
    switchClient: async (t: string) => { calls.switched.push(t); },
  };
  return { calls, deps };
}

const spec = {
  wrapArgv: ["agmux-wrap", "claude"],
  env: { PATH: "/bin", AGMUX_HUB_URL: "http://h", AGMUX_SESSION_ID: "abc12345" },
};

test("resumeIntoSession opens a new window in an existing session and switches the client", async () => {
  const { calls, deps } = placementSpy(true);
  const h = await resumeIntoSession(spec, "work", "abc12345", deps);
  expect(calls.newWindow).toHaveLength(1);
  expect(calls.newSession).toHaveLength(0);
  expect(calls.newWindow[0].sessionName).toBe("work");
  expect(calls.newWindow[0].windowName).toBe("agmux:abc12345");
  expect(calls.newWindow[0].cmd).toEqual(["agmux-wrap", "claude"]);
  // only the agmux env allowlist is forwarded (hub url + session id), PATH dropped
  expect(calls.newWindow[0].env).toEqual({ AGMUX_HUB_URL: "http://h", AGMUX_SESSION_ID: "abc12345" });
  expect(calls.newWindow[0].detach).toBe(true);
  expect(calls.switched).toEqual(["work:@7"]);
  expect(h).toEqual({ argv: [] });
});

test("resumeIntoSession creates the session when missing, then switches", async () => {
  const { calls, deps } = placementSpy(false);
  const h = await resumeIntoSession(spec, "gone", "abc12345", deps);
  expect(calls.newSession).toHaveLength(1);
  expect(calls.newWindow).toHaveLength(0);
  expect(calls.newSession[0].sessionName).toBe("gone");
  expect(calls.newSession[0].windowName).toBe("agmux:abc12345");
  expect(calls.switched).toEqual(["gone:@1"]);
  expect(h).toEqual({ argv: [] });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test packages/cli/tests/dash-actions.test.ts`
Expected: FAIL — `resumeIntoSession` / `ResumePlacementDeps` not exported.

- [ ] **Step 4: Implement the placement helper and rewrite resume**

In `packages/cli/src/dash-actions.ts`:

Update the tmux-place import (line 11) to:
```ts
import { newWindow, newSession, hasSession, switchClient, readCurrentPane } from "./tmux-place.ts";
```

Update the relaunch import (line 10) to:
```ts
import { buildRelaunchSpec, type RelaunchSpec } from "./relaunch.ts";
```

**Replace** the `resumeIntoNewWindow` function (lines 45-62) with:

```ts
// Placement deps for resume — injectable so the tmux dance is unit-testable.
export interface ResumePlacementDeps {
  hasSession: (name: string) => Promise<boolean>;
  newWindow: typeof newWindow;
  newSession: typeof newSession;
  switchClient: (target: string) => Promise<void>;
}

const defaultPlacementDeps: ResumePlacementDeps = { hasSession, newWindow, newSession, switchClient };

// Resume a closed agent into the session dash runs in (the caller's session).
// If that session exists, add a new window; if not (dash launched outside tmux),
// create the session with the same name and the agent as its first window. Then
// move the client onto the new window. Returns the exit sentinel so a popup closes
// onto the freshly switched-to agent.
export async function resumeIntoSession(
  spec: RelaunchSpec,
  targetSession: string,
  label: string,
  deps: ResumePlacementDeps = defaultPlacementDeps,
): Promise<Handoff> {
  const windowName = `agmux:${label}`;
  const cmd = spec.wrapArgv;
  const env = relaunchEnv(spec.env);
  const coords = (await deps.hasSession(targetSession))
    ? await deps.newWindow({ sessionName: targetSession, windowName, cmd, env, detach: true })
    : await deps.newSession({ sessionName: targetSession, windowName, cmd, env });
  await deps.switchClient(`${coords.session}:${coords.window}`);
  return { argv: [] };
}
```

**Rewrite** `makeActions(...).resume` (lines 97-108) to:

```ts
    async resume(row: SessionRow): Promise<Handoff | null> {
      const r = await fetch(`${hubUrl}/sessions/${row.session_id}`);
      const { session, usage } = (await r.json()) as { session: SessionRow; usage: { turn_count: number } | null };
      const spec = buildRelaunchSpec(session, {
        hubUrl, wrapBin, registry: createDefaultRegistry(), baseEnv: process.env,
        turnCount: usage?.turn_count ?? 0,
      });
      // Outside tmux: no client to switch — hand the terminal to the relaunched agent.
      if (!inTmux) return { argv: spec.wrapArgv, env: spec.env };
      // In tmux (popup or inline): place the agent in a new window of the caller's
      // session and switch the client onto it.
      const coords = await readCurrentPane().catch(() => null);
      const target = coords?.session ?? session.tmux_session ?? "agmux";
      const h = await resumeIntoSession(spec, target, row.session_id.slice(0, 8));
      // popup: exit sentinel closes the popup onto the agent. inline tmux: client
      // already switched, keep the dash alive (return null).
      return popup ? h : null;
    },
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test packages/cli/tests/dash-actions.test.ts`
Expected: PASS (the two new placement tests + the unchanged `attachInPopup` tests).

- [ ] **Step 6: Typecheck and commit**

Run: `bun run --filter @agmux/tui typecheck && bun run --filter @agmux/cli typecheck`
Expected: no errors.

```bash
git add packages/cli/src/dash-actions.ts packages/tui/src/types.ts packages/cli/tests/dash-actions.test.ts
git commit -m "cli: resume closed sessions into the caller's tmux session"
```

---

## Task 4: Wire the filter, status-aware Enter, and notices into the dash UI

**Files:**
- Modify: `packages/tui/src/opentui/HeaderBar.tsx`
- Modify: `packages/tui/src/opentui/FooterBar.tsx`
- Modify: `packages/tui/src/opentui/DashApp.tsx`
- Modify: `packages/tui/src/opentui/run-manage.tsx`
- Modify: `packages/tui/tests/opentui/dash-app.test.tsx`

**Interfaces:**
- Consumes: `inGroup`, `nextGroup`, `type ActivityGroup` from `../shared/group.ts`; `searchRows` from `../shared/search.ts`; `TERMINAL_STATUSES` from `@agmux/protocol`; `Actions` (now `resume: Promise<Handoff | null>`).
- Produces: `DashAppProps.initialGroup?: ActivityGroup`; `RunManageOpts.initialGroup?: ActivityGroup` (default `"open"`).

- [ ] **Step 1: Write the failing tests**

Append to `packages/tui/tests/opentui/dash-app.test.tsx`:

```ts
test("f cycles the activity group; closed sessions are hidden until shown", async () => {
  const rows = [
    mkRow({ session_id: "agx-open111", status: "running", tmux_session: "main", tmux_window: "w1" }),
    mkRow({ session_id: "agx-closed22", status: "ended" }),
  ];
  const { renderer, renderOnce, captureCharFrame, mockInput } = await testRender(
    <DashApp
      feed={fakeFeed(rows)} source={noSource} actions={noActions}
      hubUrl="http://localhost:0" defaultPreview="detail" intervalMs={1000}
      onHandoff={() => {}} onQuit={() => {}}
    />,
    { width: 120, height: 24 },
  );
  await renderOnce();
  // default group is "open": closed row hidden, open row shown
  expect(captureCharFrame()).toContain("agx-open111");
  expect(captureCharFrame()).not.toContain("agx-closed22");

  await act(async () => { mockInput.pressKey("f"); }); // -> closed
  await renderOnce();
  expect(captureCharFrame()).toContain("agx-closed22");
  expect(captureCharFrame()).not.toContain("agx-open111");

  await act(async () => { mockInput.pressKey("f"); }); // -> all
  await renderOnce();
  expect(captureCharFrame()).toContain("agx-open111");
  expect(captureCharFrame()).toContain("agx-closed22");

  renderer.destroy();
});

test("Enter on a closed session resumes; Enter on a live session attaches", async () => {
  const calls: string[] = [];
  const spyActions: Actions = {
    async attach() { calls.push("attach"); return null; },
    async kill() {},
    async resume() { calls.push("resume"); return { argv: [] }; },
  };

  const closed = [mkRow({ session_id: "agx-closed99", status: "lost" })];
  const r1 = await testRender(
    <DashApp
      feed={fakeFeed(closed)} source={noSource} actions={spyActions}
      hubUrl="http://localhost:0" defaultPreview="detail" intervalMs={1000}
      initialGroup="all" onHandoff={() => {}} onQuit={() => {}}
    />,
    { width: 120, height: 24 },
  );
  await r1.renderOnce();
  await act(async () => { (r1.mockInput as unknown as { pressEnter: () => void }).pressEnter(); });
  await r1.renderOnce();
  expect(calls).toEqual(["resume"]);
  r1.renderer.destroy();

  calls.length = 0;
  const live = [mkRow({ session_id: "agx-live01", status: "running", tmux_session: "m", tmux_window: "w" })];
  const r2 = await testRender(
    <DashApp
      feed={fakeFeed(live)} source={noSource} actions={spyActions}
      hubUrl="http://localhost:0" defaultPreview="detail" intervalMs={1000}
      onHandoff={() => {}} onQuit={() => {}}
    />,
    { width: 120, height: 24 },
  );
  await r2.renderOnce();
  await act(async () => { (r2.mockInput as unknown as { pressEnter: () => void }).pressEnter(); });
  await r2.renderOnce();
  expect(calls).toEqual(["attach"]);
  r2.renderer.destroy();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/tui/tests/opentui/dash-app.test.tsx`
Expected: FAIL — `initialGroup` prop unknown / `f` does nothing (closed row still hidden in "all" assertions) / resume not dispatched on closed.

- [ ] **Step 3: Update HeaderBar (counts over all rows + group indicator)**

Replace `packages/tui/src/opentui/HeaderBar.tsx` entirely with:

```tsx
/** @jsxImportSource @opentui/react */
import type { SessionRow, SessionStatus } from "@agmux/protocol";
import type { ActivityGroup } from "../shared/group.ts";

function count(rows: SessionRow[], s: SessionStatus[]): number {
  return rows.filter((r) => s.includes(r.status)).length;
}

// `rows` here is the full fetched set (not the group-filtered view) so the
// counts always reveal how many sessions sit in the groups you can switch to.
export function HeaderBar(props: { rows: SessionRow[]; connected: boolean; hubUrl: string; group: ActivityGroup }) {
  const { rows } = props;
  return (
    <box style={{ flexDirection: "row", height: 1, justifyContent: "space-between", paddingLeft: 1, paddingRight: 1 }}>
      <text>
        <span fg="#cba6f7">agmux dash</span>
        {"  "}
        <span fg="#89dceb">[{props.group}]</span>
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

- [ ] **Step 4: Update FooterBar (hint wording + notice line)**

Replace `packages/tui/src/opentui/FooterBar.tsx` entirely with:

```tsx
/** @jsxImportSource @opentui/react */
const HINT = "j/k move · g/G top/bottom · s sort · f filter · / search · ⏎ attach · x kill · tab preview · p panel · ? help · q quit";

export function FooterBar(props: { error: string | null; searching: boolean; search: string; confirmKill: string | null; notice: string | null }) {
  if (props.confirmKill) return <text fg="#f38ba8">kill {props.confirmKill}? y/n</text>;
  if (props.searching) return <text>search: {props.search}▏</text>;
  if (props.notice) return <text fg="#f9e2af">{props.notice}</text>;
  if (props.error) return <text fg="#f38ba8">hub unreachable — reconnecting… ({props.error})</text>;
  return <text fg="#6c7086">{HINT}</text>;
}
```

- [ ] **Step 5: Update DashApp (group state, `f`, search rename, Enter dispatch, notice, plumbing)**

In `packages/tui/src/opentui/DashApp.tsx`:

5a. Update imports — line 4 and the shared imports:
```tsx
import { LIVE_STATUSES, TERMINAL_STATUSES, type SessionRow } from "@agmux/protocol";
```
and add after the `searchRows` import (line 8 from Task 2):
```tsx
import { inGroup, nextGroup, type ActivityGroup } from "../shared/group.ts";
```

5b. Add `initialGroup` to `DashAppProps` (after `intervalMs` on line 21):
```tsx
  intervalMs: number;
  initialGroup?: ActivityGroup;
```

5c. Rename the search state and add group + notice state. Replace lines 55-59:
```tsx
  const [sortKey, setSortKey] = useState<SortKey>("last");
  const [filter, setFilter] = useState("");
  const [filtering, setFiltering] = useState(false);
  const [confirmKill, setConfirmKill] = useState<SessionRow | null>(null);
  const [showHelp, setShowHelp] = useState(false);
```
with:
```tsx
  const [sortKey, setSortKey] = useState<SortKey>("last");
  const [search, setSearch] = useState("");
  const [searching, setSearching] = useState(false);
  const [group, setGroup] = useState<ActivityGroup>(props.initialGroup ?? "open");
  const [confirmKill, setConfirmKill] = useState<SessionRow | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
```

5d. Update the `visible` memo (line 61) to apply the group filter then search:
```tsx
  const visible = useMemo(
    () => sortRows(searchRows(rows ?? [], search).filter((r) => inGroup(r, group)), sortKey),
    [rows, search, group, sortKey],
  );
```

5e. Rewrite the keyboard handler block (lines 104-133). Replace the `filtering` branch, the `/` handler, the Enter handler, and add `f` + notice-dismiss:

```tsx
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

    // Any key dismisses a lingering notice (a failed attach/resume message).
    if (notice) setNotice(null);

    if (key.name === "q") { props.onQuit(); return; }
    if (key.name === "?") { setShowHelp(true); return; }
    if (key.name === "j" || key.name === "down") { move(1); return; }
    if (key.name === "k" || key.name === "up") { move(-1); return; }
    if (key.name === "g") { setSelectedId(visible[0]?.session_id ?? null); return; }
    if (key.name === "G") { setSelectedId(visible[visible.length - 1]?.session_id ?? null); return; }
    if (key.name === "s") { setSortKey((k) => nextSort(k)); return; }
    if (key.name === "f") { setGroup((g) => nextGroup(g)); return; }
    if (key.name === "p") { setShowPreview((v) => !v); return; }
    if (key.name === "tab") { setMode((m) => TABS[(TABS.indexOf(m) + 1) % TABS.length]!); return; }
    if (key.name === "/") { setSearch(""); setSearching(true); return; }
    if (key.name === "return" && selected) {
      const isTerminal = TERMINAL_STATUSES.includes(selected.status);
      const act = isTerminal ? props.actions.resume : props.actions.attach;
      void act(selected)
        .then((h) => { if (h) { props.onHandoff(h); props.onQuit(); } })
        .catch((e) => setNotice(`${isTerminal ? "resume" : "attach"} failed: ${e?.message ?? String(e)}`));
      return;
    }
    if (key.name === "x" && selected && LIVE_STATUSES.includes(selected.status)) { setConfirmKill(selected); return; }
  });
```

5f. Update the help panel text (lines 142-143) to mention `f` and "search":
```tsx
        <text>j/k move · g/G top/bottom · s sort · f filter · / search</text>
        <text>tab preview tab · p show/hide preview · ⏎ attach/resume</text>
```

5g. Update the HeaderBar usage (line 152) to pass all rows + group:
```tsx
      <HeaderBar rows={rows ?? []} connected={!error} hubUrl={hubUrl} group={group} />
```

5h. Update the FooterBar usage (line 170) for the renamed props + notice:
```tsx
      <FooterBar error={error} searching={searching} search={search} confirmKill={confirmKill?.session_id.slice(0, 13) ?? null} notice={notice} />
```

- [ ] **Step 6: Thread `initialGroup` through run-manage**

In `packages/tui/src/opentui/run-manage.tsx`:

6a. Add to `RunManageOpts` (after `defaultPreview`):
```ts
  defaultPreview: PreviewMode;
  initialGroup?: ActivityGroup;
```
and add the import at the top:
```ts
import type { ActivityGroup } from "../shared/group.ts";
```

6b. Pass it into `<DashApp>` (in the `createRoot(...).render` block):
```tsx
      defaultPreview={o.defaultPreview}
      initialGroup={o.initialGroup ?? "open"}
      intervalMs={o.intervalMs}
```

- [ ] **Step 7: Run tests + typecheck**

Run: `bun test packages/tui/tests/opentui/dash-app.test.tsx && bun run --filter @agmux/tui typecheck`
Expected: PASS (existing 3 tests + 2 new); no type errors.

- [ ] **Step 8: Commit**

```bash
git add packages/tui/src/opentui/HeaderBar.tsx packages/tui/src/opentui/FooterBar.tsx packages/tui/src/opentui/DashApp.tsx packages/tui/src/opentui/run-manage.tsx packages/tui/tests/opentui/dash-app.test.tsx
git commit -m "tui: dash activity-group filter (f), status-aware enter, notices"
```

---

## Task 5: Fetch all statuses + derive initial group in the dash entry

**Files:**
- Modify: `packages/cli/src/dash.ts`
- Modify: `packages/cli/tests/dash.test.ts`

**Interfaces:**
- Consumes: `initialGroup` from `@agmux/tui`; `buildLsQuery` from `./ls.ts`; `RunManageOpts` (now has optional `initialGroup`).
- Produces: the dash hub query carries no `status` param (hub returns all statuses); `runManage` receives `initialGroup` derived from `opts.status`.

- [ ] **Step 1: Inspect the existing dash test to mirror its harness**

Run: `cat packages/cli/tests/dash.test.ts`
Note how it stubs `runManageImpl` (capturing `RunManageOpts`) and asserts on the built query. Reuse that harness shape in Step 2.

- [ ] **Step 2: Write the failing test**

Add to `packages/cli/tests/dash.test.ts` (adapt the deps stub to match the file's existing pattern — capture the `RunManageOpts` passed to `runManageImpl`):

```ts
import { initialGroup } from "@agmux/tui";

test("dash fetches all statuses (no status param) and derives the initial group", async () => {
  let captured: any = null;
  const deps = {
    isTTY: () => true,
    runManageImpl: async (o: any) => { captured = o; return 0; },
    makeSourceImpl: () => ({ async mirror() { return ""; }, async usage() { return null; } }),
    makeActionsImpl: () => ({ async attach() { return null; }, async kill() {}, async resume() { return null; } }),
    errOut: () => {},
  };
  // default opts.status === "open"
  await dashCmd(
    { hubUrl: "http://h", wrapBin: "agmux-wrap", intervalMs: 1000, preview: "mirror", popup: false,
      limit: 50, sort: "started", asc: false, reverse: false, status: "open" } as any,
    deps as any,
  );
  expect(captured.query.has("status")).toBe(false);
  expect(captured.initialGroup).toBe("open");
});

test("dash maps --status closed to the closed initial group", async () => {
  let captured: any = null;
  const deps = {
    isTTY: () => true,
    runManageImpl: async (o: any) => { captured = o; return 0; },
    makeSourceImpl: () => ({ async mirror() { return ""; }, async usage() { return null; } }),
    makeActionsImpl: () => ({ async attach() { return null; }, async kill() {}, async resume() { return null; } }),
    errOut: () => {},
  };
  await dashCmd(
    { hubUrl: "http://h", wrapBin: "agmux-wrap", intervalMs: 1000, preview: "mirror", popup: false,
      limit: 50, sort: "started", asc: false, reverse: false, status: "closed" } as any,
    deps as any,
  );
  expect(captured.query.has("status")).toBe(false);
  expect(captured.initialGroup).toBe("closed");
  expect(initialGroup("closed")).toBe("closed"); // sanity: re-export reachable from cli
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test packages/cli/tests/dash.test.ts`
Expected: FAIL — `captured.query.has("status")` is `true` (status still sent) and `captured.initialGroup` is `undefined`.

- [ ] **Step 4: Implement — strip status from the query, pass initialGroup**

In `packages/cli/src/dash.ts`:

4a. Update the imports at the top:
```ts
import { runManage, type RunManageOpts, type PreviewSource, type Actions, initialGroup } from "@agmux/tui";
```

4b. Replace the `runManageImpl` call (lines 31-38) with:
```ts
  return deps.runManageImpl({
    hubUrl: opts.hubUrl,
    // The dash fetches ALL statuses (omit the status param → hub returns all) and
    // filters client-side by activity group; `--status`/config only seeds the
    // initial group.
    query: buildLsQuery({ ...opts, status: undefined }),
    intervalMs: opts.intervalMs,
    defaultPreview: opts.preview,
    initialGroup: initialGroup(opts.status),
    source: deps.makeSourceImpl(opts.hubUrl),
    actions: deps.makeActionsImpl(opts.hubUrl, opts.wrapBin, opts.popup),
  });
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test packages/cli/tests/dash.test.ts`
Expected: PASS (new tests + existing dash tests still green).

- [ ] **Step 6: Typecheck and commit**

Run: `bun run --filter @agmux/cli typecheck`
Expected: no errors.

```bash
git add packages/cli/src/dash.ts packages/cli/tests/dash.test.ts
git commit -m "cli: dash fetches all statuses, seeds initial activity group"
```

---

## Task 6: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Run the whole test suite**

Run: `bun test`
Expected: all packages green, including the renamed `search.test.ts`, new `group.test.ts`, updated `dash-app.test.tsx`, `dash-actions.test.ts`, `dash.test.ts`.

- [ ] **Step 2: Typecheck every package**

Run: `bun run typecheck`
Expected: no errors across all workspaces.

- [ ] **Step 3: Build the consumers that ship binaries**

Run: `bun run --filter @agmux/tui build && bun run --filter @agmux/cli build`
Expected: builds succeed.

- [ ] **Step 4: Manual smoke (documented; requires a running hub + tmux)**

With `agmux-hub` running and at least one ended session recorded:
1. `agmux dash` → header shows `[open]`; only live sessions listed; the `closed` count is non-zero in the header.
2. Press `f` → `[closed]`; ended/lost sessions appear. Press `f` → `[all]`; everything. Press `f` → back to `[open]`.
3. Press `/`, type a fragment → footer shows `search: …`; list narrows; the active group still applies.
4. Select a closed session, press Enter → the agent relaunches in a new window of the current tmux session and the client switches onto it. In a tmux popup, the popup closes onto the resumed agent.
5. Select a live session, press Enter → attaches as before.

- [ ] **Step 5: Update CHANGELOG**

Add an entry under the unreleased/alpha section of `CHANGELOG.md`:
```markdown
- dash: activity-group filter (`f` cycles open/closed/all); Enter on a closed session resumes it into the current tmux session; the `/` free-text match is now labelled "search".
```

```bash
git add CHANGELOG.md
git commit -m "docs: changelog for dash activity-group filter + resume-on-closed"
```

---

## Self-Review Notes (author)

- **Spec coverage:** terminology rename (Task 2 + Task 4 labels), activity-group filter + `f` + client-side fetch-all + initial-group derivation (Tasks 1, 4, 5), header counts over all rows + group indicator (Task 4), status-aware Enter → resume with caller-session placement incl. session-missing fallback (Tasks 3, 4), graceful failure notice (Task 4), known `--limit` bound (documented in spec; surfaced via header counts). All covered.
- **Type consistency:** `ActivityGroup` defined in Task 1, consumed by Tasks 4/5; `resume: Promise<Handoff | null>` set in Task 3 before DashApp relies on it in Task 4; `searchRows`/`matchesSearch` named consistently across Tasks 2 and 4; `RunManageOpts.initialGroup` and `DashAppProps.initialGroup` both optional defaulting to `"open"`.
- **No placeholders:** every code step shows full code; commands have expected output.
