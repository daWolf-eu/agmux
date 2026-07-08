# dash `y` yank-field popup — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a vim-style `y` command to `agmux dash` that opens a popup listing 10 relevant fields of the selected session, each digit-prefixed, and copies the chosen field's value to the system clipboard.

**Architecture:** A pure field-builder in `@agmux/tui` (`shared/yank.ts`) turns a `SessionRow` into a fixed 10-entry list. An autodetecting clipboard writer in `@agmux/cli` (`clipboard.ts`) is injected into the TUI via a new `Actions.copy` method (matching the existing `attach`/`kill`/`resume`/`mirror`/`usage` dependency-injection pattern). `DashApp` gains a modal popup + keyboard branch that maps digits/cursor to `yankFields`, calls `actions.copy`, and reports via the existing footer `notice`.

**Tech Stack:** Bun, TypeScript, React 19 on `@opentui/react` 0.4.1, `bun test`.

## Global Constraints

- Runtime is **Bun ≥ 1.3** only; no Node.js APIs beyond what Bun implements. Shell out with `Bun.spawn` (dynamic args), never `Bun.$` with dynamic arrays.
- The TUI package (`@agmux/tui`) must stay **side-effect-free / injectable** — no direct shelling out for the clipboard; it goes through the injected `Actions.copy`. cli owns the concrete impl.
- **macOS-verified, Linux best-effort.** Clipboard must degrade gracefully (OSC 52 fallback) rather than throw when no native tool exists.
- Fields come **only from `SessionRow`** — never the async usage buffer.
- Digit→field mapping is **fixed** (stable slots): `1`–`9` then `0` for the 10th; empty fields keep their slot, shown dimmed, non-copyable.
- Follow existing code style: 2-space indent, `/** @jsxImportSource @opentui/react */` pragma on `.tsx`, muted Catppuccin-ish hex colors already used in the file (`#6c7086`, `#cdd6f4`, `#45475a`, `BORDER = #7f849c`).
- Commit messages: short, no AI attribution (per repo convention, e.g. `feat: …`, `test: …`, `refactor: …`).

---

### Task 1: Field builder — `shared/yank.ts`

**Files:**
- Create: `packages/tui/src/shared/yank.ts`
- Create (test): `packages/tui/tests/shared/yank.test.ts`
- Modify: `packages/tui/src/opentui/PreviewPane.tsx` (reuse the shared `tmuxTarget`)

**Interfaces:**
- Consumes: `SessionRow` from `@agmux/protocol`.
- Produces:
  - `export interface YankField { label: string; value: string; empty: boolean; }`
  - `export function tmuxTarget(row: SessionRow): string;` — `""` when no tmux session, else `` `${tmux_session}:${tmux_window}${tmux_pane ? " " + tmux_pane : ""}` ``.
  - `export function yankFields(row: SessionRow): YankField[];` — exactly 10 entries in fixed order: Session ID, Native ID, CWD, Command, Project, TMUX, PID, Host, Profile, Parent ID.

- [ ] **Step 1: Write the failing test**

Create `packages/tui/tests/shared/yank.test.ts`:

```ts
import { test, expect } from "bun:test";
import { yankFields, tmuxTarget } from "../../src/shared/yank.ts";
import { mkRow } from "../helpers/mk-row.ts";

test("yankFields returns 10 fields in fixed label order", () => {
  const fields = yankFields(mkRow());
  expect(fields.map((f) => f.label)).toEqual([
    "Session ID", "Native ID", "CWD", "Command", "Project",
    "TMUX", "PID", "Host", "Profile", "Parent ID",
  ]);
});

test("yankFields formats values from a fully-populated row", () => {
  const row = mkRow({
    session_id: "agx-abc", native_session_id: "nat-1", cwd: "/work/proj",
    command: "claude", args: ["--resume", "x"], project: "proj",
    tmux_session: "main", tmux_window: "w1", tmux_pane: "%3",
    pid: 4242, host: "mac", profile: "default", parent_session_id: "agx-parent",
  });
  const by = Object.fromEntries(yankFields(row).map((f) => [f.label, f.value]));
  expect(by["Session ID"]).toBe("agx-abc");
  expect(by["Native ID"]).toBe("nat-1");
  expect(by["CWD"]).toBe("/work/proj");
  expect(by["Command"]).toBe("claude --resume x");
  expect(by["Project"]).toBe("proj");
  expect(by["TMUX"]).toBe("main:w1 %3");
  expect(by["PID"]).toBe("4242");
  expect(by["Host"]).toBe("mac");
  expect(by["Profile"]).toBe("default");
  expect(by["Parent ID"]).toBe("agx-parent");
  expect(yankFields(row).every((f) => f.empty === false)).toBe(true);
});

test("yankFields marks nullable columns empty on a sparse row", () => {
  // mkRow defaults: native_session_id/project/profile/parent_session_id = null,
  // tmux_* = null. pid defaults to 1, so PID is NOT empty here.
  const fields = Object.fromEntries(yankFields(mkRow()).map((f) => [f.label, f]));
  for (const label of ["Native ID", "Project", "TMUX", "Profile", "Parent ID"]) {
    expect(fields[label].empty).toBe(true);
    expect(fields[label].value).toBe("");
  }
  expect(fields["Session ID"].empty).toBe(false);
});

test("PID is empty when pid is null", () => {
  const pid = Object.fromEntries(yankFields(mkRow({ pid: null })).map((f) => [f.label, f]));
  expect(pid["PID"].empty).toBe(true);
  expect(pid["PID"].value).toBe("");
});

test("tmuxTarget is empty without a session and joins when present", () => {
  expect(tmuxTarget(mkRow())).toBe("");
  expect(tmuxTarget(mkRow({ tmux_session: "s", tmux_window: "w" }))).toBe("s:w");
  expect(tmuxTarget(mkRow({ tmux_session: "s", tmux_window: "w", tmux_pane: "%2" }))).toBe("s:w %2");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/tui/tests/shared/yank.test.ts`
Expected: FAIL — `Cannot find module '.../src/shared/yank.ts'`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/tui/src/shared/yank.ts`:

```ts
import type { SessionRow } from "@agmux/protocol";

export interface YankField {
  label: string;
  value: string;
  empty: boolean;
}

// tmux target as shown in the detail pane: "" when there is no tmux session,
// otherwise "session:window" plus " pane" when a pane is recorded. Shared with
// PreviewPane's DetailBody so "what you see is what you yank".
export function tmuxTarget(row: SessionRow): string {
  if (!row.tmux_session || !row.tmux_window) return "";
  return `${row.tmux_session}:${row.tmux_window}${row.tmux_pane ? ` ${row.tmux_pane}` : ""}`;
}

// The 10 most-copied fields, in a FIXED order so digit shortcuts are stable.
// Values are pure SessionRow projections (never the async usage buffer). A field
// is `empty` when its value trims to "" — empty fields keep their slot but are
// dimmed and non-copyable in the popup.
export function yankFields(row: SessionRow): YankField[] {
  const raw: [string, string][] = [
    ["Session ID", row.session_id],
    ["Native ID", row.native_session_id ?? ""],
    ["CWD", row.cwd],
    ["Command", [row.command, ...row.args].join(" ")],
    ["Project", row.project ?? ""],
    ["TMUX", tmuxTarget(row)],
    ["PID", row.pid == null ? "" : String(row.pid)],
    ["Host", row.host],
    ["Profile", row.profile ?? ""],
    ["Parent ID", row.parent_session_id ?? ""],
  ];
  return raw.map(([label, value]) => ({ label, value, empty: value.trim() === "" }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/tui/tests/shared/yank.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Refactor PreviewPane to reuse `tmuxTarget`**

In `packages/tui/src/opentui/PreviewPane.tsx`:

Add the import near the top (after the existing imports):

```tsx
import { tmuxTarget } from "../shared/yank.ts";
```

Delete the local `tmuxFull` function (lines ~10-13):

```tsx
function tmuxFull(r: SessionRow): string {
  if (!r.tmux_session || !r.tmux_window) return "—";
  return `${r.tmux_session}:${r.tmux_window}${r.tmux_pane ? ` ${r.tmux_pane}` : ""}`;
}
```

Change the TMUX row inside `DetailBody`'s `fields` array from:

```tsx
    ["TMUX", tmuxFull(r)],
```

to:

```tsx
    ["TMUX", tmuxTarget(r) || "—"],
```

- [ ] **Step 6: Verify typecheck + existing preview tests still pass**

Run: `bun run --filter @agmux/tui typecheck && bun test packages/tui/tests`
Expected: PASS — typecheck clean, no regressions (the detail pane still shows `main:w1 %3` or `—`).

- [ ] **Step 7: Commit**

```bash
git add packages/tui/src/shared/yank.ts packages/tui/tests/shared/yank.test.ts packages/tui/src/opentui/PreviewPane.tsx
git commit -m "feat: add yankFields builder and share tmuxTarget with detail pane"
```

---

### Task 2: Autodetecting clipboard writer — `clipboard.ts`

**Files:**
- Create: `packages/cli/src/clipboard.ts`
- Create (test): `packages/cli/tests/clipboard.test.ts`

**Interfaces:**
- Produces:
  - `export interface ClipboardDeps { platform: string; env: Record<string, string | undefined>; which: (cmd: string) => boolean; spawn: (argv: string[], input: string) => Promise<boolean>; writeOut: (data: string) => void; }`
  - `export function osc52(text: string, tmux: boolean): string;`
  - `export function clipboardCandidates(platform: string, which: (cmd: string) => boolean): string[][];`
  - `export function copyToClipboard(text: string, deps?: ClipboardDeps): Promise<void>;`

- [ ] **Step 1: Write the failing test**

Create `packages/cli/tests/clipboard.test.ts`:

```ts
import { test, expect } from "bun:test";
import {
  copyToClipboard, clipboardCandidates, osc52, type ClipboardDeps,
} from "../src/clipboard.ts";

function mkDeps(over: Partial<ClipboardDeps> = {}): ClipboardDeps & {
  spawned: { argv: string[]; input: string }[]; written: string[];
} {
  const spawned: { argv: string[]; input: string }[] = [];
  const written: string[] = [];
  return {
    platform: "darwin",
    env: {},
    which: () => true,
    spawn: async (argv, input) => { spawned.push({ argv, input }); return true; },
    writeOut: (d) => { written.push(d); },
    spawned, written, ...over,
  };
}

test("darwin prefers pbcopy", () => {
  expect(clipboardCandidates("darwin", () => true)).toEqual([["pbcopy"]]);
});

test("linux tries wl-copy, xclip, xsel in order when all present", () => {
  expect(clipboardCandidates("linux", () => true)).toEqual([
    ["wl-copy"],
    ["xclip", "-selection", "clipboard"],
    ["xsel", "--clipboard", "--input"],
  ]);
});

test("linux skips tools not on PATH", () => {
  const which = (c: string) => c === "xclip";
  expect(clipboardCandidates("linux", which)).toEqual([["xclip", "-selection", "clipboard"]]);
});

test("unknown platform has no native candidates", () => {
  expect(clipboardCandidates("freebsd", () => true)).toEqual([]);
});

test("copyToClipboard spawns the first native tool with the text as stdin", async () => {
  const deps = mkDeps();
  await copyToClipboard("hello", deps);
  expect(deps.spawned).toEqual([{ argv: ["pbcopy"], input: "hello" }]);
  expect(deps.written).toEqual([]);
});

test("falls back to OSC 52 when there is no native tool", async () => {
  const deps = mkDeps({ platform: "freebsd" });
  await copyToClipboard("hi", deps);
  expect(deps.spawned).toEqual([]);
  expect(deps.written).toEqual([osc52("hi", false)]);
});

test("falls back to OSC 52 when the native spawn fails", async () => {
  const deps = mkDeps({ spawn: async () => false });
  await copyToClipboard("hi", deps);
  expect(deps.written).toEqual([osc52("hi", false)]);
});

test("osc52 encodes base64 and terminates with BEL", () => {
  const b64 = Buffer.from("hi", "utf8").toString("base64");
  expect(osc52("hi", false)).toBe(`\x1b]52;c;${b64}\x07`);
});

test("osc52 wraps in tmux passthrough (inner ESC doubled) when tmux=true", () => {
  const b64 = Buffer.from("hi", "utf8").toString("base64");
  const inner = `\x1b]52;c;${b64}\x07`;
  const doubled = inner.replace(/\x1b/g, "\x1b\x1b");
  expect(osc52("hi", true)).toBe(`\x1bPtmux;\x1b${doubled}\x1b\\`);
});

test("copyToClipboard uses tmux-wrapped OSC 52 when $TMUX is set and no native tool", async () => {
  const deps = mkDeps({ platform: "freebsd", env: { TMUX: "/tmp/tmux-501/default,123,0" } });
  await copyToClipboard("hi", deps);
  expect(deps.written).toEqual([osc52("hi", true)]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/cli/tests/clipboard.test.ts`
Expected: FAIL — `Cannot find module '.../src/clipboard.ts'`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/cli/src/clipboard.ts`:

```ts
// Autodetecting clipboard writer. Chain: native platform tool (pbcopy on macOS;
// wl-copy/xclip/xsel on Linux) → OSC 52 escape fallback (works over SSH and where
// no native tool is on PATH). All I/O goes through injectable ClipboardDeps so
// tests assert chain selection and OSC 52 formatting without touching the real
// clipboard.

export interface ClipboardDeps {
  platform: string;                                  // process.platform
  env: Record<string, string | undefined>;           // process.env (for $TMUX)
  which: (cmd: string) => boolean;                    // is cmd on PATH?
  spawn: (argv: string[], input: string) => Promise<boolean>; // true when exit 0
  writeOut: (data: string) => void;                   // stdout write for OSC 52
}

const defaultDeps: ClipboardDeps = {
  platform: process.platform,
  env: process.env,
  which: (cmd) => Bun.which(cmd) != null,
  spawn: async (argv, input) => {
    try {
      const proc = Bun.spawn(argv, { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
      proc.stdin.write(input);
      await proc.stdin.end();
      const code = await proc.exited;
      return code === 0;
    } catch {
      return false;
    }
  },
  writeOut: (data) => { process.stdout.write(data); },
};

// Native candidate argv lists for the platform, filtered to tools on PATH.
export function clipboardCandidates(platform: string, which: (cmd: string) => boolean): string[][] {
  const all: string[][] =
    platform === "darwin" ? [["pbcopy"]]
    : platform === "linux" ? [["wl-copy"], ["xclip", "-selection", "clipboard"], ["xsel", "--clipboard", "--input"]]
    : [];
  return all.filter((argv) => which(argv[0]!));
}

// OSC 52 clipboard-set sequence. When inside tmux, wrap in a passthrough sequence
// (\ePtmux;… with every inner ESC doubled …\e\\) so tmux forwards it to the outer
// terminal — requires tmux `set-clipboard on` / passthrough on the user's side.
export function osc52(text: string, tmux: boolean): string {
  const b64 = Buffer.from(text, "utf8").toString("base64");
  const seq = `\x1b]52;c;${b64}\x07`;
  if (!tmux) return seq;
  return `\x1bPtmux;\x1b${seq.replace(/\x1b/g, "\x1b\x1b")}\x1b\\`;
}

export async function copyToClipboard(text: string, deps: ClipboardDeps = defaultDeps): Promise<void> {
  for (const argv of clipboardCandidates(deps.platform, deps.which)) {
    if (await deps.spawn(argv, text)) return;
  }
  deps.writeOut(osc52(text, !!deps.env.TMUX));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/cli/tests/clipboard.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Typecheck**

Run: `bun run --filter @agmux/cli typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/clipboard.ts packages/cli/tests/clipboard.test.ts
git commit -m "feat: add autodetecting clipboard writer with OSC 52 fallback"
```

---

### Task 3: Wire `copy` into `Actions`

**Files:**
- Modify: `packages/tui/src/types.ts` (add `copy` to `Actions`)
- Modify: `packages/cli/src/dash-actions.ts` (implement `copy` via `copyToClipboard`)
- Modify: `packages/cli/tests/dash-actions.test.ts` (assert `copy` is wired)

**Interfaces:**
- Consumes: `copyToClipboard` from `./clipboard.ts` (Task 2).
- Produces: `Actions.copy(text: string): Promise<void>` — available to `DashApp` (Task 4).

- [ ] **Step 1: Add `copy` to the `Actions` interface**

In `packages/tui/src/types.ts`, add to the `Actions` interface (after `resume`):

```ts
  // Copy arbitrary text to the system clipboard (yank). Concrete impl in cli.
  copy(text: string): Promise<void>;
```

- [ ] **Step 2: Run typecheck to verify it fails**

Run: `bun run --filter @agmux/cli typecheck`
Expected: FAIL — `makeActions`' returned object is missing `copy`, and the test file's `noActions`-style fakes (if any) may also error. This confirms the interface tightened.

- [ ] **Step 3: Implement `copy` in `makeActions`**

In `packages/cli/src/dash-actions.ts`:

Add the import near the other local imports:

```ts
import { copyToClipboard } from "./clipboard.ts";
```

Add `copy` to the returned object (alongside `attach`/`kill`/`resume`):

```ts
    async copy(text: string): Promise<void> {
      await copyToClipboard(text);
    },
```

- [ ] **Step 4: Add a wiring assertion to the actions test**

In `packages/cli/tests/dash-actions.test.ts`, add:

```ts
test("makeActions exposes a copy() method", () => {
  const actions = makeActions("http://localhost:0", "agmux", false);
  expect(typeof actions.copy).toBe("function");
});
```

(If `makeActions` is not already imported in that file, add it to the existing import from `../src/dash-actions.ts`.)

- [ ] **Step 5: Run typecheck + actions test to verify pass**

Run: `bun run --filter @agmux/cli typecheck && bun test packages/cli/tests/dash-actions.test.ts`
Expected: PASS — typecheck clean, `copy()` assertion passes.

- [ ] **Step 6: Commit**

```bash
git add packages/tui/src/types.ts packages/cli/src/dash-actions.ts packages/cli/tests/dash-actions.test.ts
git commit -m "feat: expose Actions.copy backed by the clipboard writer"
```

---

### Task 4: DashApp yank popup + keyboard + help/footer

**Files:**
- Modify: `packages/tui/src/opentui/DashApp.tsx`
- Modify: `packages/tui/src/opentui/FooterBar.tsx` (hint text)
- Modify (test): `packages/tui/tests/opentui/dash-app.test.tsx`

**Interfaces:**
- Consumes: `yankFields` from `../shared/yank.ts` (Task 1); `Actions.copy` (Task 3); existing `pad` from `../shared/columns.ts`.
- Produces: no new exports — behavior only.

- [ ] **Step 1: Write the failing test**

In `packages/tui/tests/opentui/dash-app.test.tsx`, first update the shared `noActions` fake to satisfy the tightened interface (add `copy`):

```ts
const noActions: Actions = {
  async attach() { return null; },
  async kill() {},
  async resume() { return { argv: [] }; },
  async copy() {},
};
```

Then append these tests at the end of the file:

```ts
test("y opens the yank popup listing digit-prefixed fields", async () => {
  const rows = [mkRow({ session_id: "agx-yank-1", cwd: "/work/proj" })];
  const { renderer, renderOnce, captureCharFrame, mockInput } = await testRender(
    <DashApp
      feed={fakeFeed(rows)} source={noSource} actions={noActions}
      hubUrl="http://localhost:0" defaultPreview="detail" intervalMs={1000}
      onHandoff={() => {}} onQuit={() => {}}
    />,
    { width: 120, height: 30 },
  );
  await renderOnce();
  await act(async () => { mockInput.pressKey("y"); });
  await renderOnce();
  const frame = captureCharFrame();
  expect(frame).toContain("yank field");
  expect(frame).toContain("1");
  expect(frame).toContain("Session ID");
  expect(frame).toContain("CWD");
  renderer.destroy();
});

test("pressing a digit copies that field and shows a notice", async () => {
  const copied: string[] = [];
  const actions: Actions = { ...noActions, async copy(t) { copied.push(t); } };
  const rows = [mkRow({ session_id: "agx-yank-2", cwd: "/work/proj" })];
  const { renderer, renderOnce, captureCharFrame, mockInput } = await testRender(
    <DashApp
      feed={fakeFeed(rows)} source={noSource} actions={actions}
      hubUrl="http://localhost:0" defaultPreview="detail" intervalMs={1000}
      onHandoff={() => {}} onQuit={() => {}}
    />,
    { width: 120, height: 30 },
  );
  await renderOnce();
  await act(async () => { mockInput.pressKey("y"); });
  await renderOnce();
  await act(async () => { mockInput.pressKey("1"); }); // 1 = Session ID
  await renderOnce();
  expect(copied).toEqual(["agx-yank-2"]);
  const frame = captureCharFrame();
  expect(frame).toContain("copied Session ID");
  expect(frame).not.toContain("yank field"); // popup closed
  renderer.destroy();
});

test("yanking an empty field shows an is-empty notice and does not copy", async () => {
  const copied: string[] = [];
  const actions: Actions = { ...noActions, async copy(t) { copied.push(t); } };
  // native_session_id defaults to null -> Native ID (digit 2) is empty.
  const rows = [mkRow({ session_id: "agx-yank-3", native_session_id: null })];
  const { renderer, renderOnce, captureCharFrame, mockInput } = await testRender(
    <DashApp
      feed={fakeFeed(rows)} source={noSource} actions={actions}
      hubUrl="http://localhost:0" defaultPreview="detail" intervalMs={1000}
      onHandoff={() => {}} onQuit={() => {}}
    />,
    { width: 120, height: 30 },
  );
  await renderOnce();
  await act(async () => { mockInput.pressKey("y"); });
  await renderOnce();
  await act(async () => { mockInput.pressKey("2"); }); // 2 = Native ID (empty)
  await renderOnce();
  expect(copied).toEqual([]);
  expect(captureCharFrame()).toContain("Native ID is empty");
  renderer.destroy();
});

test("escape closes the yank popup without copying", async () => {
  const copied: string[] = [];
  const actions: Actions = { ...noActions, async copy(t) { copied.push(t); } };
  const rows = [mkRow({ session_id: "agx-yank-4" })];
  const { renderer, renderOnce, captureCharFrame, mockInput } = await testRender(
    <DashApp
      feed={fakeFeed(rows)} source={noSource} actions={actions}
      hubUrl="http://localhost:0" defaultPreview="detail" intervalMs={1000}
      onHandoff={() => {}} onQuit={() => {}}
    />,
    { width: 120, height: 30 },
  );
  await renderOnce();
  await act(async () => { mockInput.pressKey("y"); });
  await renderOnce();
  expect(captureCharFrame()).toContain("yank field");
  await act(async () => { (mockInput as unknown as { pressEscape: () => void }).pressEscape(); });
  await renderOnce();
  expect(captureCharFrame()).not.toContain("yank field");
  expect(copied).toEqual([]);
  renderer.destroy();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/tui/tests/opentui/dash-app.test.tsx`
Expected: FAIL — new tests fail (no `yank field` popup, no `copied …` notice). Pre-existing tests still pass.

- [ ] **Step 3: Add imports + state to DashApp**

In `packages/tui/src/opentui/DashApp.tsx`:

Add to imports (near the other `../shared/*` imports):

```tsx
import { yankFields } from "../shared/yank.ts";
import { pad } from "../shared/columns.ts";
```

Add state (after the `const [notice, setNotice] = useState<string | null>(null);` line):

```tsx
  const [yankOpen, setYankOpen] = useState(false);
  const [yankCursor, setYankCursor] = useState(0);
```

- [ ] **Step 4: Add the yank keyboard branch**

In the `useKeyboard` callback, add a `doYank` helper just above the callback (inside the component, after `move`):

```tsx
  const doYank = (i: number) => {
    if (!selected) return;
    const field = yankFields(selected)[i];
    setYankOpen(false);
    if (!field) return;
    if (field.empty) { setNotice(`${field.label} is empty`); return; }
    void props.actions
      .copy(field.value)
      .then(() => setNotice(`copied ${field.label}`))
      .catch((e) => setNotice(`copy failed: ${e?.message ?? String(e)}`));
  };
```

Then, inside `useKeyboard`, add this branch immediately after the `if (showHelp) { … }` line and BEFORE the `if (notice) setNotice(null);` line:

```tsx
    if (yankOpen) {
      if (key.name === "escape" || key.name === "q" || key.name === "y") { setYankOpen(false); return; }
      if (key.name === "j" || key.name === "down") { setYankCursor((c) => Math.min(9, c + 1)); return; }
      if (key.name === "k" || key.name === "up") { setYankCursor((c) => Math.max(0, c - 1)); return; }
      if (key.name === "return") { doYank(yankCursor); return; }
      if (key.name && /^[0-9]$/.test(key.name)) { doYank(key.name === "0" ? 9 : Number(key.name) - 1); return; }
      return;
    }
```

Add the opener among the global keys (e.g. right after the `if (key.name === "?") { setShowHelp(true); return; }` line):

```tsx
    if (key.name === "y" && selected) { setYankCursor(0); setYankOpen(true); return; }
```

- [ ] **Step 5: Render the popup**

In the render, add this early-return block immediately after the existing `if (showHelp) { … }` block (before the main `return (`):

```tsx
  if (yankOpen && selected) {
    const fields = yankFields(selected);
    const lw = fields.reduce((m, f) => Math.max(m, f.label.length), 0);
    const digit = (i: number) => (i === 9 ? "0" : String(i + 1));
    return (
      <box style={{ flexDirection: "column", border: true, borderColor: BORDER, paddingLeft: 1, paddingRight: 1 }} title=" yank field ">
        {fields.map((f, i) => {
          const cursor = i === yankCursor;
          const fg = cursor ? "#cdd6f4" : f.empty ? "#45475a" : "#a6adc8";
          return (
            <text key={i} fg={fg}>
              {`${cursor ? "›" : " "} ${digit(i)}  ${pad(f.label, lw, "left")}  ${f.empty ? "—" : f.value}`}
            </text>
          );
        })}
        <text fg="#6c7086">1-0/⏎ copy · j/k move · esc close</text>
      </box>
    );
  }
```

- [ ] **Step 6: Add the help-overlay key line**

In the `showHelp` render block, update the key list so `y` is documented. Change:

```tsx
        <text>x kill · ? help · q quit</text>
```

to:

```tsx
        <text>y yank field · x kill · ? help · q quit</text>
```

- [ ] **Step 7: Update the footer hint**

In `packages/tui/src/opentui/FooterBar.tsx`, change the `HINT` constant to include yank (insert `· y yank ` before `· x kill`):

```tsx
const HINT = "j/k move · g/G top/bottom · s sort · f filter · / search · ⏎ attach · y yank · x kill · tab preview · p panel · ? help · q quit";
```

- [ ] **Step 8: Run the dash-app tests to verify they pass**

Run: `bun test packages/tui/tests/opentui/dash-app.test.tsx`
Expected: PASS — all pre-existing tests plus the 4 new yank tests.

- [ ] **Step 9: Full TUI typecheck + test sweep**

Run: `bun run --filter @agmux/tui typecheck && bun test packages/tui`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add packages/tui/src/opentui/DashApp.tsx packages/tui/src/opentui/FooterBar.tsx packages/tui/tests/opentui/dash-app.test.tsx
git commit -m "feat: add y yank-field popup to dash"
```

---

### Task 5: Docs + full-suite verification

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `README.md` (dash keybindings section, if one exists)

- [ ] **Step 1: Check whether the README documents dash keys**

Run: `grep -n "yank\|attach\|kill\|dash" README.md | head -20`
Expected: locate any dash keybinding list. If a key list exists, add `y` — yank a field of the selected session to the clipboard. If no such list exists, skip the README edit (do not invent a new section).

- [ ] **Step 2: Add a CHANGELOG entry**

In `CHANGELOG.md`, under the current unreleased/alpha section (match the existing format in the file), add:

```markdown
- dash: `y` yanks a field of the selected session to the system clipboard via a digit-prefixed popup (autodetects pbcopy/wl-copy/xclip/xsel, OSC 52 fallback).
```

- [ ] **Step 3: Run the full test suite + typecheck across the workspace**

Run: `bun test && bun run --filter '*' typecheck`
Expected: PASS — entire suite green, all packages typecheck.

- [ ] **Step 4: Manual smoke check (evidence before done)**

Run the dash against a running hub and confirm: `y` opens the popup; a digit copies (paste elsewhere to confirm); an empty field reports `… is empty`; `esc`/`q` close it.

Run: `bun run --filter @agmux/cli build && ./packages/cli/dist/agmux dash` (or the symlinked `agmux dash`), then exercise the flow.
Expected: popup renders, clipboard receives the value, notices appear.

- [ ] **Step 5: Commit**

```bash
git add CHANGELOG.md README.md
git commit -m "docs: note dash y yank-field command"
```

---

## Self-Review

**Spec coverage:**
- Autodetecting clipboard (pbcopy/wl-copy/xclip/xsel + OSC 52, tmux passthrough) → Task 2. ✓
- `Actions.copy` DI wiring → Task 3. ✓
- Fixed 10-field builder, row-only, empty detection, TMUX-mirrors-detail → Task 1. ✓
- `y` opener, digit/cursor/enter keys, esc/q/y close, empty→notice, error→notice, no-selection no-op → Task 4. ✓
- Help overlay + footer hint → Task 4 (steps 6-7). ✓
- Tests for builder / clipboard / popup behavior → Tasks 1, 2, 4. ✓
- Known OSC 52 caveat: documented in spec; implementation keeps native path primary and only writes the escape on fallback. ✓

**Placeholder scan:** none — every code/step block is concrete.

**Type consistency:** `yankFields`/`tmuxTarget`/`YankField` (Task 1) used identically in Task 4; `copyToClipboard`/`osc52`/`clipboardCandidates`/`ClipboardDeps` (Task 2) used in Tasks 2-3; `Actions.copy(text: string): Promise<void>` defined in Task 3 and consumed in Task 4. `doYank` index math (`"0"` → 9) matches `digit()` render (`i === 9` → `"0"`).
