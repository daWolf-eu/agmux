# dash `A` attach-target popup (phase 1, local) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `A` in `agmux dash` opens a yank-style popup that opens the selected session inline, in a new pane / window / tmux session, or in a new terminal tab / window; ⏎ uses a configurable default; `agmux attach --placement` exposes the same targets.

**Architecture:** One fixed list of placements (`@agmux/protocol`), one pure availability model (`@agmux/tui` `shared/attach-targets.ts`) used by both the popup (to dim targets) and the cli actions (to validate and pick defaults), one cli executor in `dash-actions.ts` shared by the dash and `agmux attach --placement`. Live sessions in a new pane/window are shown through a second tmux client on a throw-away grouped "view" session, so closing that pane never touches the agent.

**Tech Stack:** TypeScript on Bun, `bun test`, OpenTUI React (`@opentui/react/test-utils`), tmux, smol-toml config.

**Spec:** `docs/superpowers/specs/2026-10-09-dash-attach-popup-design.md` (phase 1). Remote rows / `m` mode toggle are out of scope (remote spec phase 2).

## Global Constraints

- Worktree: `/Users/davidwolf/dawolf/agmux/AGX.git.feature-remote-sandbox-sessions`, branch `feature/remote-sandbox-sessions`. Run every command from the worktree root. Baseline: `bun test` 916 pass, `bun run typecheck` clean.
- Slot order is fixed and never reordered: `1 inline · 2 new-pane · 3 new-window · 4 new-session · 5 peek · 6 new-tab · 7 new-terminal`.
- Phase 1: `peek` is always disabled (live: reason `planned`; closed: reason `ends with popup`). `new-tab` / `new-terminal` are enabled only when `[terminal] new_tab` / `new_window` are configured (no built-in terminal default).
- Config keys exactly: `[attach] live`, `[attach] closed`, `[attach] view_detach_key` (default `M-d`); `[terminal] new_window`, `[terminal] new_tab` (argv arrays containing `{cmd}`; `[]` = unset).
- ⏎ behaviour without config must stay what it is today: live → inline; closed → new window in tmux, inline (handoff) outside tmux.
- OpenTUI reports a shifted letter as lowercase `name` + `shift: true`: match `A` as `key.name === "a" && key.shift`.
- The tui package never shells out; side effects stay behind `Actions` (packages/tui/AGENTS.md).
- Commit messages: `feat(dash): …` / `feat(attach): …` style, short, no AI attribution lines.
- Keep `bun run typecheck` and `bun test` green after every task.

## Review Focus

1. **Agent already in the caller's tmux session** + new pane / new window: a view client would show a window containing itself → must fall back to inline (switch-client). Test in Task 5.
2. **Dash running in a popup, closed row:** `inline` would put the agent in the popup pane, which dies with the popup → `inline` disabled ("in popup"); ⏎ still resumes into a new window as today. Tests in Task 2 and Task 5.
3. **Configured default impossible in context** (e.g. `[attach] live = "new-window"` while not in tmux): ⏎ must fall back to inline, not error. Test in Task 2.
4. **Terminal template substitution with awkward values** (`{cmd}` inside a larger string, paths with spaces/quotes): must be shell-quoted, never split. Test in Task 4.
5. **Stale-live row (tmux session gone) attached with an explicit placement:** must go through resume with the placement validated as a *closed* session. Test in Task 5.

---

### Task 1: Placement list and `[attach]` / `[terminal]` config

**Files:**
- Create: `packages/protocol/src/attach.ts`
- Modify: `packages/protocol/src/index.ts`
- Modify: `packages/wrapper/src/profile.ts` (append after `loadDashConfig`)
- Modify: `packages/wrapper/src/index.ts:22`
- Test: `packages/protocol/tests/attach.test.ts`, `packages/wrapper/tests/attach-config.test.ts`

**Interfaces:**
- Produces: `ATTACH_PLACEMENTS`, `type AttachPlacement`, `isAttachPlacement(v: unknown): v is AttachPlacement` (from `@agmux/protocol`); `interface AttachConfig { live?: AttachPlacement; closed?: AttachPlacement; viewDetachKey?: string; terminal: { newWindow?: string[]; newTab?: string[] } }`, `parseAttachSection(attach: unknown, terminal: unknown): AttachConfig`, `loadAttachConfig(configPath: string): AttachConfig` (from `@agmux/wrapper`).

- [ ] **Step 1: Write the failing tests**

`packages/protocol/tests/attach.test.ts`:
```ts
import { test, expect } from "bun:test";
import { ATTACH_PLACEMENTS, isAttachPlacement } from "../src/attach.ts";

test("placements are the popup's fixed slot order", () => {
  expect([...ATTACH_PLACEMENTS]).toEqual([
    "inline", "new-pane", "new-window", "new-session", "peek", "new-tab", "new-terminal",
  ]);
});

test("isAttachPlacement accepts only known names", () => {
  expect(isAttachPlacement("new-window")).toBe(true);
  expect(isAttachPlacement("window")).toBe(false);
  expect(isAttachPlacement(undefined)).toBe(false);
  expect(isAttachPlacement(3)).toBe(false);
});
```

`packages/wrapper/tests/attach-config.test.ts`:
```ts
import { test, expect } from "bun:test";
import { parseAttachSection } from "../src/profile.ts";

test("missing sections yield an empty config", () => {
  expect(parseAttachSection(undefined, undefined)).toEqual({ terminal: {} });
});

test("valid [attach] and [terminal] parse", () => {
  expect(parseAttachSection(
    { live: "new-window", closed: "new-session", view_detach_key: "M-q" },
    { new_window: ["open", "-na", "Ghostty.app", "--args", "-e", "{cmd}"], new_tab: [] },
  )).toEqual({
    live: "new-window", closed: "new-session", viewDetachKey: "M-q",
    terminal: { newWindow: ["open", "-na", "Ghostty.app", "--args", "-e", "{cmd}"] },
  });
});

test("an empty template array means unset", () => {
  expect(parseAttachSection(undefined, { new_tab: [] })).toEqual({ terminal: {} });
});

test("unknown placement throws", () => {
  expect(() => parseAttachSection({ live: "window" }, undefined)).toThrow(/\[attach\] live must be one of/);
});

test("unknown keys throw", () => {
  expect(() => parseAttachSection({ lvie: "inline" }, undefined)).toThrow(/\[attach\] unknown key "lvie"/);
  expect(() => parseAttachSection(undefined, { window: ["x"] })).toThrow(/\[terminal\] unknown key "window"/);
});

test("a template without {cmd} throws", () => {
  expect(() => parseAttachSection(undefined, { new_window: ["open", "-na", "Ghostty.app"] }))
    .toThrow(/\[terminal\] new_window must contain \{cmd\}/);
});

test("a template with a non-string element throws", () => {
  expect(() => parseAttachSection(undefined, { new_window: ["open", 3, "{cmd}"] }))
    .toThrow(/\[terminal\] new_window must be an array of non-empty strings/);
});

test("view_detach_key must be a non-empty string", () => {
  expect(() => parseAttachSection({ view_detach_key: "" }, undefined)).toThrow(/view_detach_key/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/protocol/tests/attach.test.ts packages/wrapper/tests/attach-config.test.ts`
Expected: FAIL — `Cannot find module '../src/attach.ts'` and `parseAttachSection` is not exported.

- [ ] **Step 3: Implement**

`packages/protocol/src/attach.ts`:
```ts
// Where `agmux attach --placement` / the dash `A` popup opens a session. The
// order IS the popup's fixed digit slots (1–7): never reorder, only append.
export const ATTACH_PLACEMENTS = [
  "inline", "new-pane", "new-window", "new-session", "peek", "new-tab", "new-terminal",
] as const;
export type AttachPlacement = (typeof ATTACH_PLACEMENTS)[number];

export function isAttachPlacement(v: unknown): v is AttachPlacement {
  return typeof v === "string" && (ATTACH_PLACEMENTS as readonly string[]).includes(v);
}
```

`packages/protocol/src/index.ts` — add the line:
```ts
export * from "./attach.ts";
```

`packages/wrapper/src/profile.ts` — change the protocol import at the top to:
```ts
import { expandStatusFilter, isAttachPlacement, ATTACH_PLACEMENTS, type AgentKind, type AttachPlacement } from "@agmux/protocol";
```
and append at the end of the file:
```ts
// [attach] + [terminal]: how `agmux attach` / the dash open a session (see
// docs/superpowers/specs/2026-10-09-dash-attach-popup-design.md).
export interface AttachConfig {
  live?: AttachPlacement;    // ⏎ default for a live session
  closed?: AttachPlacement;  // ⏎ default for a closed session (resume)
  viewDetachKey?: string;    // the one key bound in a view client's key table
  terminal: { newWindow?: string[]; newTab?: string[] };
}

function placementOpt(label: string, v: unknown): AttachPlacement {
  if (!isAttachPlacement(v))
    throw new Error(`${label} must be one of ${ATTACH_PLACEMENTS.join("|")}, got ${JSON.stringify(v)}`);
  return v;
}

// An argv template: [] = unset; otherwise non-empty strings, at least one containing {cmd}.
function templateOpt(label: string, v: unknown): string[] | undefined {
  if (!Array.isArray(v) || !v.every((s) => typeof s === "string" && s.length > 0))
    throw new Error(`${label} must be an array of non-empty strings, got ${JSON.stringify(v)}`);
  if (v.length === 0) return undefined;
  if (!v.some((s: string) => s.includes("{cmd}"))) throw new Error(`${label} must contain {cmd}`);
  return v as string[];
}

function tableOf(label: string, raw: unknown, keys: string[]): Record<string, unknown> {
  if (raw === undefined) return {};
  if (typeof raw !== "object" || raw === null) throw new Error(`${label} must be a table`);
  const r = raw as Record<string, unknown>;
  for (const k of Object.keys(r)) if (!keys.includes(k)) throw new Error(`${label} unknown key ${JSON.stringify(k)}`);
  return r;
}

export function parseAttachSection(attach: unknown, terminal: unknown): AttachConfig {
  const a = tableOf("[attach]", attach, ["live", "closed", "view_detach_key"]);
  const t = tableOf("[terminal]", terminal, ["new_window", "new_tab"]);
  const out: AttachConfig = { terminal: {} };
  if (a.live !== undefined) out.live = placementOpt("[attach] live", a.live);
  if (a.closed !== undefined) out.closed = placementOpt("[attach] closed", a.closed);
  if (a.view_detach_key !== undefined) {
    if (typeof a.view_detach_key !== "string" || a.view_detach_key.length === 0)
      throw new Error(`[attach] view_detach_key must be a non-empty string, got ${JSON.stringify(a.view_detach_key)}`);
    out.viewDetachKey = a.view_detach_key;
  }
  if (t.new_window !== undefined) {
    const w = templateOpt("[terminal] new_window", t.new_window);
    if (w) out.terminal.newWindow = w;
  }
  if (t.new_tab !== undefined) {
    const tab = templateOpt("[terminal] new_tab", t.new_tab);
    if (tab) out.terminal.newTab = tab;
  }
  return out;
}

// Parses ONLY [attach] and [terminal]. Missing file/sections → defaults. Invalid values throw.
export function loadAttachConfig(configPath: string): AttachConfig {
  if (!fs.existsSync(configPath)) return { terminal: {} };
  const raw = parseToml(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
  return parseAttachSection(raw.attach, raw.terminal);
}
```

`packages/wrapper/src/index.ts:22` — extend the profile export list with `loadAttachConfig, parseAttachSection, type AttachConfig`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/protocol packages/wrapper && bun run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol packages/wrapper
git commit -m "feat(attach): placement list and [attach]/[terminal] config"
```

---

### Task 2: Pure attach-target model

**Files:**
- Create: `packages/tui/src/shared/attach-targets.ts`
- Modify: `packages/tui/src/index.ts`
- Test: `packages/tui/tests/shared/attach-targets.test.ts`

**Interfaces:**
- Consumes: `ATTACH_PLACEMENTS`, `AttachPlacement` (Task 1).
- Produces:
  - `type AttachKind = "live" | "closed" | "none"`; `attachKind(row: SessionRow): AttachKind`
  - `interface AttachCtx { inTmux: boolean; popup: boolean; terminalWindow: boolean; terminalTab: boolean }`; `NO_ATTACH_CTX: AttachCtx`
  - `interface AttachTarget { placement: AttachPlacement; label: string; enabled: boolean; reason: string }`
  - `interface AttachDefaults { live?: AttachPlacement; closed?: AttachPlacement }`
  - `attachTargets(kind: AttachKind, ctx: AttachCtx): AttachTarget[]` (always 7, slot order)
  - `defaultPlacement(kind: AttachKind, ctx: AttachCtx, defaults?: AttachDefaults): AttachPlacement`
  - `resolvePlacement(kind: AttachKind, ctx: AttachCtx, req: AttachPlacement | undefined, defaults?: AttachDefaults): AttachPlacement` — throws `Error("<label>: <reason>")` for a disabled request.

- [ ] **Step 1: Write the failing test**

`packages/tui/tests/shared/attach-targets.test.ts`:
```ts
import { test, expect } from "bun:test";
import {
  attachKind, attachTargets, defaultPlacement, resolvePlacement, NO_ATTACH_CTX, type AttachCtx,
} from "../../src/shared/attach-targets.ts";
import { mkRow } from "../helpers/mk-row.ts";

const TMUX: AttachCtx = { inTmux: true, popup: false, terminalWindow: false, terminalTab: false };
const POPUP: AttachCtx = { ...TMUX, popup: true };
const reasons = (ts: ReturnType<typeof attachTargets>) => Object.fromEntries(ts.map((t) => [t.placement, t.reason]));

test("attachKind: closed by status, live needs tmux coords, otherwise none", () => {
  expect(attachKind(mkRow({ status: "lost" }))).toBe("closed");
  expect(attachKind(mkRow({ status: "ended" }))).toBe("closed");
  expect(attachKind(mkRow({ status: "running", tmux_session: "s", tmux_window: "@1" }))).toBe("live");
  expect(attachKind(mkRow({ status: "running" }))).toBe("none");
});

test("seven targets in slot order with labels", () => {
  expect(attachTargets("live", TMUX).map((t) => t.label)).toEqual([
    "inline", "new pane", "new window", "new session", "peek", "new tab", "new terminal window",
  ]);
});

test("live in tmux: tmux placements on, peek planned, terminals unconfigured", () => {
  expect(reasons(attachTargets("live", TMUX))).toEqual({
    inline: "", "new-pane": "", "new-window": "", "new-session": "",
    peek: "planned", "new-tab": "not configured", "new-terminal": "not configured",
  });
});

test("outside tmux only inline and configured terminals are enabled", () => {
  const ctx = { ...NO_ATTACH_CTX, terminalWindow: true };
  const on = attachTargets("live", ctx).filter((t) => t.enabled).map((t) => t.placement);
  expect(on).toEqual(["inline", "new-terminal"]);
  expect(reasons(attachTargets("live", ctx))["new-pane"]).toBe("not in tmux");
});

test("closed in a popup: inline disabled, peek ends with popup", () => {
  const r = reasons(attachTargets("closed", POPUP));
  expect(r.inline).toBe("in popup");
  expect(r.peek).toBe("ends with popup");
  expect(r["new-window"]).toBe("");
});

test("no tmux pane: everything disabled", () => {
  expect(attachTargets("none", TMUX).every((t) => !t.enabled && t.reason === "no tmux pane")).toBe(true);
});

test("defaults without config keep today's ⏎ behaviour", () => {
  expect(defaultPlacement("live", TMUX)).toBe("inline");
  expect(defaultPlacement("closed", TMUX)).toBe("new-window");
  expect(defaultPlacement("closed", NO_ATTACH_CTX)).toBe("inline");
  expect(defaultPlacement("closed", POPUP)).toBe("new-window");
});

test("configured defaults apply when available", () => {
  expect(defaultPlacement("live", TMUX, { live: "new-session" })).toBe("new-session");
  expect(defaultPlacement("closed", TMUX, { closed: "new-pane" })).toBe("new-pane");
});

test("a configured default impossible in context falls back to inline", () => {
  expect(defaultPlacement("live", NO_ATTACH_CTX, { live: "new-window" })).toBe("inline");
  expect(defaultPlacement("live", TMUX, { live: "peek" })).toBe("inline");
});

test("a closed default of inline in a popup falls back to new-window", () => {
  expect(defaultPlacement("closed", POPUP, { closed: "inline" })).toBe("new-window");
});

test("resolvePlacement passes enabled requests, rejects disabled ones, defaults when absent", () => {
  expect(resolvePlacement("live", TMUX, "new-pane")).toBe("new-pane");
  expect(() => resolvePlacement("live", NO_ATTACH_CTX, "new-pane")).toThrow("new pane: not in tmux");
  expect(resolvePlacement("closed", TMUX, undefined)).toBe("new-window");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/tui/tests/shared/attach-targets.test.ts`
Expected: FAIL — `Cannot find module '../../src/shared/attach-targets.ts'`.

- [ ] **Step 3: Implement**

`packages/tui/src/shared/attach-targets.ts`:
```ts
import {
  ATTACH_PLACEMENTS, LIVE_STATUSES, TERMINAL_STATUSES, type AttachPlacement, type SessionRow,
} from "@agmux/protocol";

// What a session offers to open: a live tmux pane, a closed session (resume),
// or a live session with no tmux coords (nothing to open).
export type AttachKind = "live" | "closed" | "none";

export function attachKind(row: SessionRow): AttachKind {
  if (TERMINAL_STATUSES.includes(row.status)) return "closed";
  if (LIVE_STATUSES.includes(row.status) && row.tmux_session && row.tmux_window) return "live";
  return "none";
}

// The caller's situation. Computed once by the cli (attachCtxFor) and shared by
// the popup (to dim targets) and the actions (to validate) so both agree.
export interface AttachCtx {
  inTmux: boolean;         // running inside a tmux client
  popup: boolean;          // the dash runs in `display-popup -E` (`agmux dash --popup`)
  terminalWindow: boolean; // [terminal] new_window configured
  terminalTab: boolean;    // [terminal] new_tab configured
}

export const NO_ATTACH_CTX: AttachCtx = { inTmux: false, popup: false, terminalWindow: false, terminalTab: false };

export interface AttachTarget {
  placement: AttachPlacement;
  label: string;
  enabled: boolean;
  reason: string; // why it is disabled; "" when enabled
}

export interface AttachDefaults { live?: AttachPlacement; closed?: AttachPlacement }

const LABELS: Record<AttachPlacement, string> = {
  inline: "inline", "new-pane": "new pane", "new-window": "new window", "new-session": "new session",
  peek: "peek", "new-tab": "new tab", "new-terminal": "new terminal window",
};

function reasonFor(p: AttachPlacement, kind: AttachKind, ctx: AttachCtx): string {
  if (kind === "none") return "no tmux pane";
  switch (p) {
    // A resumed agent in the dash's own pane would die with the popup.
    case "inline": return kind === "closed" && ctx.popup ? "in popup" : "";
    case "new-pane":
    case "new-window":
    case "new-session": return ctx.inTmux ? "" : "not in tmux";
    // Phase 1: peek is not built yet; for a resume it can never work.
    case "peek": return kind === "closed" ? "ends with popup" : "planned";
    case "new-tab": return ctx.terminalTab ? "" : "not configured";
    case "new-terminal": return ctx.terminalWindow ? "" : "not configured";
  }
}

// Always all placements, in slot order; unavailable ones keep their slot (yank convention).
export function attachTargets(kind: AttachKind, ctx: AttachCtx): AttachTarget[] {
  return ATTACH_PLACEMENTS.map((placement) => {
    const reason = reasonFor(placement, kind, ctx);
    return { placement, label: LABELS[placement], enabled: reason === "", reason };
  });
}

// ⏎: the configured default when it is possible here, else inline, else a new
// window (closed session in a popup). Without config this is the pre-popup behaviour.
export function defaultPlacement(kind: AttachKind, ctx: AttachCtx, defaults: AttachDefaults = {}): AttachPlacement {
  const want: AttachPlacement = kind === "closed"
    ? defaults.closed ?? (ctx.inTmux ? "new-window" : "inline")
    : defaults.live ?? "inline";
  const targets = attachTargets(kind, ctx);
  const enabled = (p: AttachPlacement) => targets.find((t) => t.placement === p)!.enabled;
  for (const p of [want, "inline", "new-window"] as const) if (enabled(p)) return p;
  return "inline";
}

// An explicit request must be available; no request means the default.
export function resolvePlacement(
  kind: AttachKind, ctx: AttachCtx, req: AttachPlacement | undefined, defaults: AttachDefaults = {},
): AttachPlacement {
  if (req === undefined) return defaultPlacement(kind, ctx, defaults);
  const t = attachTargets(kind, ctx).find((x) => x.placement === req)!;
  if (!t.enabled) throw new Error(`${t.label}: ${t.reason}`);
  return req;
}
```

`packages/tui/src/index.ts` — add:
```ts
export {
  attachKind, attachTargets, defaultPlacement, resolvePlacement, NO_ATTACH_CTX,
  type AttachKind, type AttachCtx, type AttachTarget, type AttachDefaults,
} from "./shared/attach-targets.ts";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/tui && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/tui/src/shared/attach-targets.ts packages/tui/src/index.ts packages/tui/tests/shared/attach-targets.test.ts
git commit -m "feat(dash): attach-target availability model"
```

---

### Task 3: `A` popup in the dash

**Files:**
- Modify: `packages/tui/src/types.ts` (Actions)
- Modify: `packages/tui/src/opentui/Overlays.tsx` (generic picker, `AttachOverlay`, help key)
- Modify: `packages/tui/src/opentui/FooterBar.tsx:7-18` (hint)
- Modify: `packages/tui/src/opentui/DashApp.tsx`
- Modify: `packages/tui/src/opentui/run-manage.tsx` (pass `attachCtx`)
- Modify: `packages/tui/src/index.ts` (export `AttachRequest`)
- Test: `packages/tui/tests/opentui/dash-app.test.tsx`

**Interfaces:**
- Consumes: `attachKind`, `attachTargets`, `NO_ATTACH_CTX`, `AttachCtx`, `AttachTarget` (Task 2); `ATTACH_PLACEMENTS`, `AttachPlacement` (Task 1).
- Produces: `interface AttachRequest { placement: AttachPlacement }`; `Actions.attach(row, req?: AttachRequest)`, `Actions.resume(row, req?: AttachRequest)` (no `req` = configured default); `DashAppProps.attachCtx?: AttachCtx`; `RunManageOpts.attachCtx?: AttachCtx`.

- [ ] **Step 1: Write the failing tests** — append to `packages/tui/tests/opentui/dash-app.test.tsx` (add `type AttachRequest` to the existing `../../src/types.ts` import):

```tsx
const TMUX_CTX = { inTmux: true, popup: false, terminalWindow: false, terminalTab: false };

test("A opens the attach popup listing the seven targets, unavailable ones dimmed with a reason", async () => {
  const rows = [mkRow({ session_id: "agx-att-1", status: "running", tmux_session: "m", tmux_window: "@1" })];
  const { renderer, renderOnce, captureCharFrame, mockInput } = await testRender(
    <DashApp
      feedFor={fakeFeed(rows)} source={noSource} actions={noActions} attachCtx={TMUX_CTX}
      hubUrl="http://localhost:0" defaultPreview="detail" intervalMs={1000} spinnerMs={0}
      onHandoff={() => {}} onQuit={() => {}}
    />,
    { width: 120, height: 30 },
  );
  await renderOnce();
  await act(async () => { mockInput.pressKey("A"); });
  await renderOnce();
  const frame = captureCharFrame();
  expect(frame).toContain("attach to");
  expect(frame).not.toMatch(/[┌┐└┘─]/);
  const lines = frame.split("\n");
  expect(lines.find((l) => l.includes("▌"))).toMatch(/▌ 1\s+inline/);
  expect(frame).toMatch(/3\s+new window/);
  expect(frame).toMatch(/5\s+peek\s+planned/);
  expect(frame).toMatch(/7\s+new terminal window\s+not configured/);
  expect(frame).toContain("[1-7/⏎] open");
  renderer.destroy();
});

test("a digit in the attach popup attaches with that placement", async () => {
  const reqs: (AttachRequest | undefined)[] = [];
  const actions: Actions = { ...noActions, async attach(_r, req) { reqs.push(req); return null; } };
  const rows = [mkRow({ session_id: "agx-att-2", status: "running", tmux_session: "m", tmux_window: "@1" })];
  const { renderer, renderOnce, captureCharFrame, mockInput } = await testRender(
    <DashApp
      feedFor={fakeFeed(rows)} source={noSource} actions={actions} attachCtx={TMUX_CTX}
      hubUrl="http://localhost:0" defaultPreview="detail" intervalMs={1000} spinnerMs={0}
      onHandoff={() => {}} onQuit={() => {}}
    />,
    { width: 120, height: 30 },
  );
  await renderOnce();
  await act(async () => { mockInput.pressKey("A"); });
  await renderOnce();
  await act(async () => { mockInput.pressKey("3"); });
  await renderOnce();
  expect(reqs).toEqual([{ placement: "new-window" }]);
  expect(captureCharFrame()).not.toContain("attach to");
  renderer.destroy();
});

test("a closed row resumes through the popup; j + ⏎ picks the next slot", async () => {
  const reqs: (AttachRequest | undefined)[] = [];
  const actions: Actions = { ...noActions, async resume(_r, req) { reqs.push(req); return null; } };
  const rows = [mkRow({ session_id: "agx-att-3", status: "lost" })];
  const { renderer, renderOnce, mockInput } = await testRender(
    <DashApp
      feedFor={fakeFeed(rows)} source={noSource} actions={actions} attachCtx={TMUX_CTX} initialGroup="all"
      hubUrl="http://localhost:0" defaultPreview="detail" intervalMs={1000} spinnerMs={0}
      onHandoff={() => {}} onQuit={() => {}}
    />,
    { width: 120, height: 30 },
  );
  await renderOnce();
  await act(async () => { mockInput.pressKey("A"); });
  await renderOnce();
  await act(async () => { mockInput.pressKey("j"); });
  await renderOnce();
  await act(async () => { (mockInput as unknown as { pressEnter: () => void }).pressEnter(); });
  await renderOnce();
  expect(reqs).toEqual([{ placement: "new-pane" }]);
  renderer.destroy();
});

test("picking a disabled target shows its reason and calls nothing", async () => {
  const calls: string[] = [];
  const actions: Actions = { ...noActions, async attach() { calls.push("attach"); return null; } };
  const rows = [mkRow({ session_id: "agx-att-4", status: "running", tmux_session: "m", tmux_window: "@1" })];
  const { renderer, renderOnce, captureCharFrame, mockInput } = await testRender(
    <DashApp
      feedFor={fakeFeed(rows)} source={noSource} actions={actions}
      hubUrl="http://localhost:0" defaultPreview="detail" intervalMs={1000} spinnerMs={0}
      onHandoff={() => {}} onQuit={() => {}}
    />,
    { width: 120, height: 30 },
  );
  await renderOnce();
  await act(async () => { mockInput.pressKey("A"); });
  await renderOnce();
  await act(async () => { mockInput.pressKey("2"); }); // new pane, no attachCtx → not in tmux
  await renderOnce();
  expect(calls).toEqual([]);
  expect(captureCharFrame()).toContain("new pane: not in tmux");
  renderer.destroy();
});

test("escape closes the attach popup; Enter still uses the default (no request)", async () => {
  const reqs: (AttachRequest | undefined)[] = [];
  const actions: Actions = { ...noActions, async attach(_r, req) { reqs.push(req); return null; } };
  const rows = [mkRow({ session_id: "agx-att-5", status: "running", tmux_session: "m", tmux_window: "@1" })];
  const { renderer, renderOnce, captureCharFrame, mockInput } = await testRender(
    <DashApp
      feedFor={fakeFeed(rows)} source={noSource} actions={actions} attachCtx={TMUX_CTX}
      hubUrl="http://localhost:0" defaultPreview="detail" intervalMs={1000} spinnerMs={0}
      onHandoff={() => {}} onQuit={() => {}}
    />,
    { width: 120, height: 30 },
  );
  await renderOnce();
  await act(async () => { mockInput.pressKey("A"); });
  await renderOnce();
  await act(async () => { (mockInput as unknown as { pressEscape: () => void }).pressEscape(); });
  // A lone ESC is held ~20ms by the stdin parser before it flushes as "escape".
  await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
  await renderOnce();
  expect(captureCharFrame()).not.toContain("attach to");
  await act(async () => { (mockInput as unknown as { pressEnter: () => void }).pressEnter(); });
  await renderOnce();
  expect(reqs).toEqual([undefined]);
  renderer.destroy();
});
```

Also extend the existing help-overlay test with `expect(frame).toContain("[A]   attach to…");` and the footer test's hint list with `"[A] attach…"`.

`mockInput.pressKey("A")` sends the byte `A`, which OpenTUI parses as `name: "a", shift: true` (`@opentui/core` key parser). If the popup does not open in the first test, print the key in the handler once to confirm, and match on what arrives — do not fall back to `key.name === "A"`, which never fires (the existing `G` binding has exactly that bug; out of scope here).

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/tui/tests/opentui/dash-app.test.tsx`
Expected: FAIL — `attachCtx` is not a prop / "attach to" not rendered.

- [ ] **Step 3: Implement**

`packages/tui/src/types.ts` — add `import type { AttachPlacement } from "@agmux/protocol";` next to the `SessionRow` import, and replace the `attach` / `resume` members:
```ts
// Where to open a session; omitted = the configured default (⏎).
export interface AttachRequest { placement: AttachPlacement }

export interface Actions {
  attach(row: SessionRow, req?: AttachRequest): Promise<Handoff | null>;
  kill(row: SessionRow): Promise<void>;
  resume(row: SessionRow, req?: AttachRequest): Promise<Handoff | null>;
  // …copy and markSeen unchanged
```
`packages/tui/src/index.ts` — add `type AttachRequest` to the `./types.ts` export block.

`packages/tui/src/opentui/Overlays.tsx` — import `type AttachTarget` from `../shared/attach-targets.ts`; add `["A", "attach to…"]` to `HELP_KEYS` right after `["⏎", "attach/resume"]`; replace the whole `// --- yank` section (from `const YANK_MAX_WIDTH` to the end of `YankOverlay`) with:
```tsx
// --- pickers (yank, attach) --------------------------------------------------

const PICKER_MAX_WIDTH = 96;

interface PickerItem { key: string; label: string; value: string; dim: boolean }

// A digit-keyed list for the selected session: "▌ 1   Label   value". Dim items
// keep their slot; their value shows dimmed ("—" when empty).
function PickerOverlay(props: {
  title: string; row: SessionRow; items: PickerItem[]; cursor: number; screenWidth: number; hints: ReactNode;
}) {
  const { row, items, cursor, title } = props;
  const g = statusGlyph(row);
  const lw = Math.max(...items.map((f) => f.label.length));
  // "▌ 1   Label   value": bar(2) + digit(1) + 3 + label + 3 + value
  const prefix = 2 + 1 + 3 + lw + 3;
  const longest = Math.max(...items.map((f) => Math.max(f.dim ? 1 : 0, f.value.length)));
  const width = Math.max(40, Math.min(PICKER_MAX_WIDTH, props.screenWidth - 4, prefix + longest));
  const valueW = width - prefix;
  return (
    <Centered width={width}>
      <text wrapMode="none">
        <span fg={MOCHA.text} attributes={TextAttributes.BOLD}>{title}</span>
        <span fg={g.color} attributes={TextAttributes.BOLD}>{`   ${clip(row.name || row.session_id, width - title.length - 3)}`}</span>
      </text>
      <Blank />
      {items.map((f, i) => {
        const sel = i === cursor;
        const dim = f.dim;
        return (
          <box key={i} style={{ backgroundColor: sel ? MOCHA.surface0 : undefined }}>
            <text wrapMode="none">
              <span fg={g.color}>{sel ? "▌ " : "  "}</span>
              <span fg={dim ? MOCHA.surface2 : MOCHA.subtext0}>{f.key}</span>
              <span fg={dim ? MOCHA.surface2 : sel ? MOCHA.subtext1 : MOCHA.overlay1}>{`   ${f.label.padEnd(lw)}   `}</span>
              <span fg={dim ? MOCHA.surface2 : sel ? MOCHA.text : MOCHA.subtext0}>
                {(dim ? (f.value || "—") : clip(f.value, valueW)).padEnd(valueW)}
              </span>
            </text>
          </box>
        );
      })}
      <Blank />
      <text wrapMode="none">{props.hints}</text>
    </Centered>
  );
}

export function YankOverlay(props: { row: SessionRow; fields: YankField[]; cursor: number; screenWidth: number }) {
  const items = props.fields.map((f, i) => ({ key: i === 9 ? "0" : String(i + 1), label: f.label, value: f.value, dim: f.empty }));
  return (
    <PickerOverlay
      title="yank field" row={props.row} items={items} cursor={props.cursor} screenWidth={props.screenWidth}
      hints={<>
        <KeyHint k="1-0/⏎" label="copy" />
        <KeyHint k="j/k" label="move" lead="  " />
        <KeyHint k="esc" label="close" lead="  " />
      </>}
    />
  );
}

export function AttachOverlay(props: { row: SessionRow; targets: AttachTarget[]; cursor: number; screenWidth: number }) {
  const items = props.targets.map((t, i) => ({ key: String(i + 1), label: t.label, value: t.enabled ? "" : t.reason, dim: !t.enabled }));
  return (
    <PickerOverlay
      title="attach to" row={props.row} items={items} cursor={props.cursor} screenWidth={props.screenWidth}
      hints={<>
        <KeyHint k={`1-${items.length}/⏎`} label="open" />
        <KeyHint k="j/k" label="move" lead="  " />
        <KeyHint k="esc" label="close" lead="  " />
      </>}
    />
  );
}
```
(If the original yank code between the header row and the hint row differs from the version above, keep the original markup and only parameterise `title`, `key` and the dim value — the yank tests must stay green unchanged.)

`packages/tui/src/opentui/FooterBar.tsx` — `HINTS` becomes:
```ts
const HINTS: { key: string; label: string; drop?: number }[] = [
  { key: "j/k", label: "move", drop: 7 },
  { key: "s", label: "sort" },
  { key: "f", label: "filter", drop: 3 },
  { key: "/", label: "search", drop: 6 },
  { key: "⏎", label: "attach" },
  { key: "A", label: "attach…", drop: 4 },
  { key: "y", label: "yank", drop: 5 },
  { key: "tab", label: "preview", drop: 2 },
  { key: "p", label: "panel", drop: 1 },
  { key: "?", label: "help" },
  { key: "q", label: "quit" },
];
```

`packages/tui/src/opentui/DashApp.tsx`:
1. Imports: change the protocol import to `import { ATTACH_PLACEMENTS, LIVE_STATUSES, TERMINAL_STATUSES, type SessionRow } from "@agmux/protocol";`; add `AttachRequest` to the `../types.ts` type import; add `import { attachKind, attachTargets, NO_ATTACH_CTX, type AttachCtx } from "../shared/attach-targets.ts";`; import `AttachOverlay` alongside `HelpOverlay, YankOverlay`.
2. `DashAppProps`: add
   ```ts
   // The caller's tmux/popup/terminal situation (cli attachCtxFor). Drives which
   // attach-popup targets are enabled. Default: outside tmux, no terminals.
   attachCtx?: AttachCtx;
   ```
3. State, next to the yank state:
   ```ts
   const [attachOpen, setAttachOpen] = useState(false);
   const [attachCursor, setAttachCursor] = useState(0);
   const attachCtx = props.attachCtx ?? NO_ATTACH_CTX;
   ```
4. Next to `doYank`:
   ```ts
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
   ```
5. Keyboard: directly after the `if (yankOpen) { … }` block:
   ```ts
   if (attachOpen) {
     const last = ATTACH_PLACEMENTS.length - 1;
     if (key.name === "escape" || key.name === "q" || (key.name === "a" && key.shift)) { setAttachOpen(false); return; }
     if (key.name === "j" || key.name === "down") { setAttachCursor((c) => Math.min(last, c + 1)); return; }
     if (key.name === "k" || key.name === "up") { setAttachCursor((c) => Math.max(0, c - 1)); return; }
     if (key.name === "return") { doAttach(attachCursor); return; }
     if (key.name && /^[1-9]$/.test(key.name) && Number(key.name) <= last + 1) { doAttach(Number(key.name) - 1); return; }
     return;
   }
   ```
   After the `y` line:
   ```ts
   // OpenTUI reports a shifted letter as its lowercase name + shift.
   if (key.name === "a" && key.shift && selected) { setAttachCursor(0); setAttachOpen(true); return; }
   ```
   Replace the existing `if (key.name === "return" && selected) { … }` block with:
   ```ts
   if (key.name === "return" && selected) { openRow(selected); return; }
   ```
6. Render, after the yank overlay early return:
   ```tsx
   if (attachOpen && selected) {
     return <AttachOverlay row={selected} targets={attachTargets(attachKind(selected), attachCtx)} cursor={attachCursor} screenWidth={width} />;
   }
   ```

`packages/tui/src/opentui/run-manage.tsx` — add `attachCtx?: AttachCtx;` to `RunManageOpts` (import the type from `../shared/attach-targets.ts`) and pass `attachCtx={o.attachCtx}` to `<DashApp>`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/tui && bun run typecheck`
Expected: PASS (all existing yank/help/footer tests included).

- [ ] **Step 5: Commit**

```bash
git add packages/tui
git commit -m "feat(dash): A opens an attach-target popup"
```

---

### Task 4: Pure tmux / terminal argv builders

**Files:**
- Create: `packages/cli/src/attach-place.ts`
- Test: `packages/cli/tests/attach-place.test.ts`

**Interfaces:**
- Consumes: `AttachCoords` (`packages/cli/src/attach.ts`), `tmuxSocketArgs` (`@agmux/protocol`), `AttachConfig` (Task 1), `AttachCtx`, `AttachDefaults` (Task 2).
- Produces:
  - `interface AttachSettings { defaults: AttachDefaults; viewDetachKey: string; terminal: { newWindow?: string[]; newTab?: string[] }; agmuxBin: string }`
  - `DEFAULT_VIEW_DETACH_KEY = "M-d"`, `DEFAULT_ATTACH_SETTINGS: AttachSettings`
  - `attachSettingsFrom(cfg: AttachConfig, agmuxBin: string): AttachSettings`
  - `attachCtxFor(s: AttachSettings, env: Record<string, string | undefined>, popup: boolean): AttachCtx`
  - `viewSessionName(sessionId: string, now: number): string`, `groupedSessionName(sessionId: string): string`
  - `buildViewClientArgv(c: AttachCoords, view: string, detachKey: string): string[]`
  - `buildGroupedSessionCommands(c: AttachCoords, name: string, exists: boolean): string[][]`
  - `shellQuote(s: string): string`, `expandTemplate(tpl: string[], cmd: string[]): string[]`

- [ ] **Step 1: Write the failing test**

`packages/cli/tests/attach-place.test.ts`:
```ts
import { test, expect } from "bun:test";
import {
  attachSettingsFrom, attachCtxFor, viewSessionName, groupedSessionName, buildViewClientArgv,
  buildGroupedSessionCommands, shellQuote, expandTemplate, DEFAULT_ATTACH_SETTINGS,
} from "../src/attach-place.ts";

const C = { tmux_session: "work", tmux_window: "@3", tmux_pane: "%5", tmux_socket: "/tmp/tmux-501/default" };
const ID = "019f1898-8e0f-7000-ab55-07d09f673b59";

test("settings take config values and fill defaults", () => {
  expect(DEFAULT_ATTACH_SETTINGS.viewDetachKey).toBe("M-d");
  const s = attachSettingsFrom({ live: "new-window", terminal: { newWindow: ["x", "{cmd}"] } }, "/bin/agmux");
  expect(s).toEqual({ defaults: { live: "new-window", closed: undefined }, viewDetachKey: "M-d", terminal: { newWindow: ["x", "{cmd}"] }, agmuxBin: "/bin/agmux" });
});

test("attachCtxFor reads TMUX and the configured terminals", () => {
  const s = attachSettingsFrom({ terminal: { newTab: ["t", "{cmd}"] } }, "agmux");
  expect(attachCtxFor(s, { TMUX: "/tmp/x,1,0" }, true)).toEqual({ inTmux: true, popup: true, terminalWindow: false, terminalTab: true });
  expect(attachCtxFor(s, {}, false).inTmux).toBe(false);
});

test("names are derived from the session id prefix", () => {
  expect(groupedSessionName(ID)).toBe("agmux-019f1898");
  expect(viewSessionName(ID, 0)).toBe("agmux-view-019f1898-0");
  expect(viewSessionName(ID, 36)).toBe("agmux-view-019f1898-10");
});

test("view client: a second client on a throw-away grouped session that takes no keys", () => {
  expect(buildViewClientArgv(C, "V", "M-d")).toEqual([
    "env", "-u", "TMUX", "tmux", "-S", "/tmp/tmux-501/default",
    "new-session", "-t", "work", "-s", "V",
    ";", "set-option", "-t", "V", "destroy-unattached", "on",
    ";", "set-option", "-t", "V", "status", "off",
    ";", "set-option", "-t", "V", "prefix", "None",
    ";", "set-option", "-t", "V", "prefix2", "None",
    ";", "bind-key", "-T", "agmux-view", "M-d", "detach-client",
    ";", "set-option", "-t", "V", "key-table", "agmux-view",
    ";", "select-window", "-t", "V:@3",
    ";", "select-pane", "-t", "%5",
  ]);
});

test("view client without a pane or socket selects the window only", () => {
  const argv = buildViewClientArgv({ ...C, tmux_pane: null, tmux_socket: null }, "V", "M-d");
  expect(argv.slice(0, 5)).toEqual(["env", "-u", "TMUX", "tmux", "new-session"]);
  expect(argv.at(-1)).toBe("V:@3");
});

test("grouped session: create, switch, then mark ephemeral, then focus window and pane", () => {
  const S = ["-S", "/tmp/tmux-501/default"];
  expect(buildGroupedSessionCommands(C, "G", false)).toEqual([
    [...S, "new-session", "-d", "-t", "work", "-s", "G"],
    [...S, "switch-client", "-t", "G"],
    [...S, "set-option", "-t", "G", "destroy-unattached", "on"],
    [...S, "select-window", "-t", "G:@3"],
    [...S, "select-pane", "-t", "%5"],
  ]);
});

test("grouped session that already exists is only switched to and focused", () => {
  expect(buildGroupedSessionCommands({ ...C, tmux_pane: null, tmux_socket: null }, "G", true)).toEqual([
    ["switch-client", "-t", "G"],
    ["select-window", "-t", "G:@3"],
  ]);
});

test("shellQuote leaves safe words alone and single-quotes the rest", () => {
  expect(shellQuote("/usr/local/bin/agmux")).toBe("/usr/local/bin/agmux");
  expect(shellQuote("a b")).toBe("'a b'");
  expect(shellQuote("it's")).toBe("'it'\\''s'");
});

test("expandTemplate splices {cmd} as argv, or shell-quotes it inside a string", () => {
  const cmd = ["/Apps/My Tools/agmux", "attach", ID];
  expect(expandTemplate(["open", "-na", "Ghostty.app", "--args", "-e", "{cmd}"], cmd))
    .toEqual(["open", "-na", "Ghostty.app", "--args", "-e", "/Apps/My Tools/agmux", "attach", ID]);
  expect(expandTemplate(["osascript", "-e", "run {cmd}"], cmd))
    .toEqual(["osascript", "-e", `run '/Apps/My Tools/agmux' attach ${ID}`]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/cli/tests/attach-place.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`packages/cli/src/attach-place.ts`:
```ts
// Pure argv builders for `agmux attach --placement` and the dash attach popup
// (docs/superpowers/specs/2026-10-09-dash-attach-popup-design.md). The tmux
// dance itself runs in dash-actions.ts.
import { tmuxSocketArgs } from "@agmux/protocol";
import type { AttachConfig } from "@agmux/wrapper";
import type { AttachCtx, AttachDefaults } from "@agmux/tui";
import type { AttachCoords } from "./attach.ts";

export const DEFAULT_VIEW_DETACH_KEY = "M-d";

export interface AttachSettings {
  defaults: AttachDefaults;
  viewDetachKey: string;
  terminal: { newWindow?: string[]; newTab?: string[] };
  agmuxBin: string; // absolute when known: a new terminal may not have agmux on PATH
}

export function attachSettingsFrom(cfg: AttachConfig, agmuxBin: string): AttachSettings {
  return {
    defaults: { live: cfg.live, closed: cfg.closed },
    viewDetachKey: cfg.viewDetachKey ?? DEFAULT_VIEW_DETACH_KEY,
    terminal: cfg.terminal,
    agmuxBin,
  };
}

export const DEFAULT_ATTACH_SETTINGS: AttachSettings = attachSettingsFrom({ terminal: {} }, "agmux");

export function attachCtxFor(s: AttachSettings, env: Record<string, string | undefined>, popup: boolean): AttachCtx {
  return { inTmux: !!env.TMUX, popup, terminalWindow: !!s.terminal.newWindow, terminalTab: !!s.terminal.newTab };
}

// One grouped session per agent for "new session"; re-opening switches to it.
export function groupedSessionName(sessionId: string): string {
  return `agmux-${sessionId.slice(0, 8)}`;
}

// View sessions are per pane, so several views of one agent can coexist.
export function viewSessionName(sessionId: string, now: number): string {
  return `agmux-view-${sessionId.slice(0, 8)}-${now.toString(36)}`;
}

// The command a new pane/window runs to show a live agent: a second client
// (TMUX unset, so tmux allows it) on a throw-away session grouped with the
// agent's. Prefix and status are off and the key table holds one detach key,
// so the outer tmux keeps every other key. destroy-unattached reaps the view
// when its pane closes; the agent's own session is never touched.
export function buildViewClientArgv(c: AttachCoords, view: string, detachKey: string): string[] {
  const argv = [
    "env", "-u", "TMUX", "tmux", ...tmuxSocketArgs(c.tmux_socket),
    "new-session", "-t", c.tmux_session, "-s", view,
    ";", "set-option", "-t", view, "destroy-unattached", "on",
    ";", "set-option", "-t", view, "status", "off",
    ";", "set-option", "-t", view, "prefix", "None",
    ";", "set-option", "-t", view, "prefix2", "None",
    ";", "bind-key", "-T", "agmux-view", detachKey, "detach-client",
    ";", "set-option", "-t", view, "key-table", "agmux-view",
    ";", "select-window", "-t", `${view}:${c.tmux_window}`,
  ];
  if (c.tmux_pane) argv.push(";", "select-pane", "-t", c.tmux_pane);
  return argv;
}

// "new session" for a live agent: no nesting — a grouped session on the agent's
// server, and the caller's client switches to it. destroy-unattached is set only
// after the switch, so tmux can't reap the session before anyone is attached.
export function buildGroupedSessionCommands(c: AttachCoords, name: string, exists: boolean): string[][] {
  const sock = tmuxSocketArgs(c.tmux_socket);
  const cmds: string[][] = [];
  if (!exists) cmds.push([...sock, "new-session", "-d", "-t", c.tmux_session, "-s", name]);
  cmds.push([...sock, "switch-client", "-t", name]);
  if (!exists) cmds.push([...sock, "set-option", "-t", name, "destroy-unattached", "on"]);
  cmds.push([...sock, "select-window", "-t", `${name}:${c.tmux_window}`]);
  if (c.tmux_pane) cmds.push([...sock, "select-pane", "-t", c.tmux_pane]);
  return cmds;
}

export function shellQuote(s: string): string {
  return /^[A-Za-z0-9_\/.:=@%+,-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

// [terminal] templates: an element that IS "{cmd}" becomes the command's argv;
// "{cmd}" inside a larger string becomes the shell-quoted command line.
export function expandTemplate(tpl: string[], cmd: string[]): string[] {
  const line = cmd.map(shellQuote).join(" ");
  return tpl.flatMap((el) => (el === "{cmd}" ? cmd : [el.split("{cmd}").join(line)]));
}
```

Check `packages/cli/package.json` already depends on `@agmux/wrapper` and `@agmux/tui` (it imports both today: `bin/agmux.ts`, `dash.ts`). If `AttachCoords` import from `./attach.ts` creates a cycle later, it is type-only (`import type`) and erased.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/cli/tests/attach-place.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/attach-place.ts packages/cli/tests/attach-place.test.ts
git commit -m "feat(attach): view-client, grouped-session and terminal argv builders"
```

---

### Task 5: Execute placements in the dash actions; wire config into `agmux dash`

**Files:**
- Modify: `packages/cli/src/dash-actions.ts`
- Modify: `packages/cli/src/dash.ts`
- Modify: `packages/cli/bin/agmux.ts` (`dash` case)
- Test: `packages/cli/tests/dash-actions.test.ts`, `packages/cli/tests/dash.test.ts`

**Interfaces:**
- Consumes: Task 2 (`attachKind`, `resolvePlacement`), Task 3 (`AttachRequest`), Task 4 (all builders, `AttachSettings`, `attachCtxFor`, `DEFAULT_ATTACH_SETTINGS`), `splitPane` / `readCurrentPane` / `PaneCoords` (`tmux-place.ts`), `relaunchEnv` / `resumeIntoSession` / `defaultPlacementDeps` / `ResumePlacementDeps` (`resume-place.ts`).
- Produces: `makeActions(hubUrl, wrapBin, popup?, deps?, settings?: AttachSettings)`; `ActionDeps` gains optional `currentPane`, `spawnDetached`, `placement`, `splitPane`, `now`; `DashCmdDeps.makeActionsImpl(hubUrl, wrapBin, popup, settings)`; `dashCmd` opts gain `attach?: AttachSettings`; `loadAttachSettings(configPath: string): AttachSettings` exported from `attach-place.ts`.

- [ ] **Step 1: Write the failing tests** — append to `packages/cli/tests/dash-actions.test.ts` (reuses its `staleRow`; add imports `type ActionDeps` from `../src/dash-actions.ts` and `attachSettingsFrom` from `../src/attach-place.ts`):

```ts
const SOCK = "/private/tmp/tmux-501/default";
const TMUX_ENV = `${SOCK},123,0`;
const CALLER = { session: "caller", window: "@1", pane: "%9", socket: SOCK };
const SETTINGS = attachSettingsFrom({ terminal: { newWindow: ["term", "-e", "{cmd}"] } }, "/bin/agmux");
const liveRow = (over: Partial<SessionRow> = {}) =>
  staleRow({ tmux_session: "work", tmux_window: "@3", tmux_pane: "%5", tmux_socket: SOCK, ...over });

async function withTmux<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const orig = process.env.TMUX;
  if (value === undefined) delete process.env.TMUX; else process.env.TMUX = value;
  try { return await fn(); } finally { if (orig === undefined) delete process.env.TMUX; else process.env.TMUX = orig; }
}

async function withSession<T>(session: SessionRow, fn: () => Promise<T>): Promise<T> {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ session, usage: { turn_count: 5 } }))) as unknown as typeof fetch;
  try { return await fn(); } finally { globalThis.fetch = orig; }
}

function recorder(over: Partial<ActionDeps> = {}) {
  const tmux: string[][] = [];
  const spawned: string[][] = [];
  const deps: ActionDeps = {
    runTmux: async (a) => { tmux.push(a); },
    sessionExists: async () => true,
    currentPane: async () => CALLER,
    spawnDetached: (argv) => { spawned.push(argv); },
    now: () => 0,
    ...over,
  };
  return { tmux, spawned, deps };
}

test("live new-window: a view client in a new window of the caller's session", async () => {
  const r = recorder();
  const h = await withTmux(TMUX_ENV, () =>
    makeActions("http://hub", "agmux-wrap", false, r.deps, SETTINGS).attach(liveRow(), { placement: "new-window" }));
  expect(h).toBeNull();
  expect(r.tmux).toHaveLength(1);
  const cmd = r.tmux[0]!;
  expect(cmd.slice(0, 9)).toEqual(["-S", SOCK, "new-window", "-t", "caller:", "-n", "view:019f1898", "--", "env"]);
  expect(cmd).toContain("agmux-view-019f1898-0");
});

test("live new-pane: splits the caller's pane with a view client", async () => {
  const r = recorder();
  await withTmux(TMUX_ENV, () =>
    makeActions("http://hub", "agmux-wrap", false, r.deps, SETTINGS).attach(liveRow(), { placement: "new-pane" }));
  expect(r.tmux[0]!.slice(0, 6)).toEqual(["-S", SOCK, "split-window", "-t", "%9", "--"]);
});

test("live new-window when the agent is in the caller's own session falls back to inline", async () => {
  const r = recorder({ currentPane: async () => ({ ...CALLER, session: "work" }) });
  await withTmux(TMUX_ENV, () =>
    makeActions("http://hub", "agmux-wrap", false, r.deps, SETTINGS).attach(liveRow(), { placement: "new-window" }));
  expect(r.tmux).toEqual([
    ["-S", SOCK, "switch-client", "-t", "work:@3"],
    ["-S", SOCK, "select-pane", "-t", "%5"],
  ]);
});

test("live new-session: grouped session, switched to", async () => {
  const r = recorder({ sessionExists: async (name) => name === "work" });
  await withTmux(TMUX_ENV, () =>
    makeActions("http://hub", "agmux-wrap", false, r.deps, SETTINGS).attach(liveRow(), { placement: "new-session" }));
  expect(r.tmux.map((c) => c[2])).toEqual(["new-session", "switch-client", "set-option", "select-window", "select-pane"]);
});

test("new-terminal spawns the template with `agmux attach <id>`; popup closes", async () => {
  const r = recorder();
  const h = await withTmux(TMUX_ENV, () =>
    makeActions("http://hub", "agmux-wrap", true, r.deps, SETTINGS).attach(liveRow(), { placement: "new-terminal" }));
  expect(r.spawned).toEqual([["term", "-e", "/bin/agmux", "attach", "019f1898-8e0f-7000-ab55-07d09f673b59"]]);
  expect(h).toEqual({ argv: [] });
});

test("an unavailable placement is rejected with its reason", async () => {
  const r = recorder();
  await expect(withTmux(undefined, () =>
    makeActions("http://hub", "agmux-wrap", false, r.deps, SETTINGS).attach(liveRow(), { placement: "new-pane" })))
    .rejects.toThrow("new pane: not in tmux");
});

test("closed inline in tmux hands the dash's pane to the resumed agent", async () => {
  const r = recorder();
  const row = staleRow({ status: "lost" });
  const h = await withTmux(TMUX_ENV, () => withSession(row, () =>
    makeActions("http://hub", "agmux-wrap", false, r.deps, SETTINGS).resume(row, { placement: "inline" })));
  expect(h!.argv[0]).toBe("agmux-wrap");
  expect(r.tmux).toEqual([]);
});

test("closed new-pane splits the caller's pane with the resumed agent", async () => {
  const splits: unknown[] = [];
  const r = recorder({ splitPane: (async (a: unknown) => { splits.push(a); return { session: "caller", window: "@1", pane: "%10", socket: SOCK }; }) as ActionDeps["splitPane"] });
  const row = staleRow({ status: "lost" });
  const h = await withTmux(TMUX_ENV, () => withSession(row, () =>
    makeActions("http://hub", "agmux-wrap", false, r.deps, SETTINGS).resume(row, { placement: "new-pane" })));
  expect(h).toBeNull();
  expect(splits).toHaveLength(1);
  expect((splits[0] as { targetPane: string; cmd: string[] }).targetPane).toBe("%9");
  expect((splits[0] as { cmd: string[] }).cmd[0]).toBe("agmux-wrap");
});

test("stale-live row with a placement resumes, validated as a closed session", async () => {
  const r = recorder({ sessionExists: async () => false });
  const row = liveRow({ status: "idle" });
  // inline is fine for a closed row outside a popup → resume handoff
  const h = await withTmux(TMUX_ENV, () => withSession(row, () =>
    makeActions("http://hub", "agmux-wrap", false, r.deps, SETTINGS).attach(row, { placement: "inline" })));
  expect(h!.argv[0]).toBe("agmux-wrap");
  // peek is never available for a closed session
  await expect(withTmux(TMUX_ENV, () => withSession(row, () =>
    makeActions("http://hub", "agmux-wrap", false, r.deps, SETTINGS).attach(row, { placement: "peek" }))))
    .rejects.toThrow("peek: ends with popup");
});

test("closed row in a popup without a request still resumes into a new window", async () => {
  const placed: string[] = [];
  const r = recorder({
    placement: {
      hasSession: async () => true,
      newWindow: (async () => { placed.push("newWindow"); return { session: "caller", window: "@7", pane: "%11", socket: SOCK }; }) as never,
      newSession: (async () => { throw new Error("no"); }) as never,
      switchClient: async () => {},
    },
  });
  const row = staleRow({ status: "lost" });
  const h = await withTmux(TMUX_ENV, () => withSession(row, () =>
    makeActions("http://hub", "agmux-wrap", true, r.deps, SETTINGS).resume(row)));
  expect(placed).toEqual(["newWindow"]);
  expect(h).toEqual({ argv: [] });
});
```

In `packages/cli/tests/dash.test.ts` (it already defines `opts`) add, with `import { attachSettingsFrom } from "../src/attach-place.ts";`:
```ts
test("dash passes attach settings to the actions and the matching attachCtx to the renderer", async () => {
  let seenSettings: unknown;
  let seenCtx: unknown;
  const settings = attachSettingsFrom({ terminal: { newWindow: ["t", "{cmd}"] } }, "/bin/agmux");
  await dashCmd(
    { ...opts, attach: settings },
    {
      isTTY: () => true,
      runManageImpl: async (o) => { seenCtx = o.attachCtx; return 0; },
      makeSourceImpl: () => ({ async mirror() { return ""; }, async usage() { return null; } }),
      makeActionsImpl: (_h, _w, _p, s) => { seenSettings = s; return { async attach() { return null; }, async kill() {}, async resume() { return null; }, async copy() {}, async markSeen() {} }; },
      errOut: () => {},
    },
  );
  expect(seenSettings).toBe(settings);
  expect((seenCtx as { terminalWindow: boolean }).terminalWindow).toBe(true);
});
```
- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/cli/tests/dash-actions.test.ts packages/cli/tests/dash.test.ts`
Expected: FAIL — `makeActions` ignores the request / `attach` not in dash opts.

- [ ] **Step 3: Implement**

`packages/cli/src/dash-actions.ts` — the import block (lines 1–12) becomes:
```ts
import { $ } from "bun";
import { tmuxSocketArgs, type SessionRow } from "@agmux/protocol";
import { attachKind, resolvePlacement, type Actions, type AttachRequest, type Handoff } from "@agmux/tui";
import { createDefaultRegistry } from "@agmux/adapters";
import { buildAttachCommands, type AttachCoords } from "./attach.ts";
import { buildRelaunchSpec } from "./relaunch.ts";
import { loadProfileEnv } from "./profile-env.ts";
import { readCurrentPane, hasSession, splitPane, type PaneCoords } from "./tmux-place.ts";
import { resumeIntoSession, defaultPlacementDeps, relaunchEnv, type ResumePlacementDeps } from "./resume-place.ts";
import { copyToClipboard } from "./clipboard.ts";
import { postSeen } from "./seen.ts";
import {
  DEFAULT_ATTACH_SETTINGS, attachCtxFor, buildViewClientArgv, buildGroupedSessionCommands,
  expandTemplate, groupedSessionName, viewSessionName, type AttachSettings,
} from "./attach-place.ts";
```
(`LIVE_STATUSES` is no longer needed — `attachKind` replaces the check. Keep any re-export lines below the imports, e.g. `export { relaunchEnv, resumeIntoSession, … } from "./resume-place.ts";`, unchanged.)

Replace `ActionDeps` and everything from `export function makeActions(` to the end of `attach` with:
```ts
export interface ActionDeps {
  runTmux: (args: string[]) => Promise<void>;
  // Probe whether a tmux session still exists — injectable for tests. Defaults
  // to the real tmux `has-session`. Used to catch stale-live rows (see attach).
  sessionExists?: (name: string, socket: string | null) => Promise<boolean>;
  // The caller's tmux pane (default: tmux display-message); null outside tmux.
  currentPane?: () => Promise<PaneCoords | null>;
  // Launch a [terminal] template without waiting for it.
  spawnDetached?: (argv: string[]) => void;
  // Resume placement (new window / new session); default: real tmux.
  placement?: ResumePlacementDeps;
  splitPane?: typeof splitPane;
  now?: () => number;
}

const defaultActionDeps: ActionDeps = {
  runTmux: async (args) => { await $`tmux ${args}`.quiet(); },
  sessionExists: hasSession,
};

function spawnDetachedDefault(argv: string[]): void {
  Bun.spawn(argv, { stdio: ["ignore", "ignore", "ignore"] }).unref();
}

export function makeActions(
  hubUrl: string,
  wrapBin: string,
  popup = false,
  deps: ActionDeps = defaultActionDeps,
  settings: AttachSettings = DEFAULT_ATTACH_SETTINGS,
): Actions {
  const inTmux = !!process.env.TMUX;
  const sessionExists = deps.sessionExists ?? hasSession;
  const currentPane = deps.currentPane ?? (() => readCurrentPane().catch(() => null));
  const spawnDetached = deps.spawnDetached ?? spawnDetachedDefault;
  const placement = deps.placement ?? defaultPlacementDeps;
  const split = deps.splitPane ?? splitPane;
  const now = deps.now ?? Date.now;
  const ctx = attachCtxFor(settings, process.env, popup);
  // Opened somewhere else: in a popup the empty handoff closes the popup onto
  // it; in an inline dash the dash stays (null).
  const opened = (): Handoff | null => (popup ? { argv: [] } : null);

  function openTerminal(where: "new-tab" | "new-terminal", row: SessionRow): Handoff | null {
    const tpl = where === "new-tab" ? settings.terminal.newTab : settings.terminal.newWindow;
    if (!tpl) throw new Error(`${where}: not configured`);
    // A fresh terminal is outside tmux, so a plain `agmux attach` opens it inline there.
    spawnDetached(expandTemplate(tpl, [settings.agmuxBin, "attach", row.session_id]));
    return opened();
  }

  async function resume(row: SessionRow, req?: AttachRequest): Promise<Handoff | null> {
    const where = resolvePlacement("closed", ctx, req?.placement, settings.defaults);
    if (where === "new-tab" || where === "new-terminal") return openTerminal(where, row);
    const r = await fetch(`${hubUrl}/sessions/${row.session_id}`);
    const { session, usage } = (await r.json()) as { session: SessionRow; usage: { turn_count: number } | null };
    const spec = buildRelaunchSpec(session, {
      hubUrl, wrapBin, registry: createDefaultRegistry(), baseEnv: process.env,
      turnCount: usage?.turn_count ?? 0, loadProfileEnv,
    });
    // inline: hand the terminal (or the dash's own pane) to the relaunched agent.
    if (where === "inline") return { argv: spec.wrapArgv, env: spec.env };
    const here = await currentPane();
    const socket = here?.socket ?? null;
    const label = row.session_id.slice(0, 8);
    if (where === "new-pane") {
      if (!here) throw new Error("new pane: cannot read the current tmux pane");
      await split({ targetPane: here.pane, cmd: spec.wrapArgv, env: relaunchEnv(spec.env), detach: false, socket });
      return opened();
    }
    if (where === "new-session") {
      const coords = await placement.newSession({
        sessionName: groupedSessionName(row.session_id), windowName: `agmux:${label}`,
        cmd: spec.wrapArgv, env: relaunchEnv(spec.env), socket,
      });
      await placement.switchClient(`${coords.session}:${coords.window}`, socket);
      return opened();
    }
    // new-window: a new window of the caller's session (the pre-popup default).
    const target = here?.session ?? session.tmux_session ?? "agmux";
    const h = await resumeIntoSession(spec, target, label, placement, socket);
    return popup ? h : null;
  }

  return {
    async attach(row: SessionRow, req?: AttachRequest): Promise<Handoff | null> {
      // No tmux target to focus → nothing to attach to (unchanged no-op).
      if (attachKind(row) !== "live") return null;
      // Status is only a lagging approximation of tmux reality: a LIVE row whose
      // tmux session is gone (e.g. pinned live by pid reuse, spec §8) would make
      // a doomed attach that errors out — resume it instead of failing.
      if (!(await sessionExists(row.tmux_session!, row.tmux_socket))) return resume(row, req);
      const where = resolvePlacement("live", ctx, req?.placement, settings.defaults);
      const coords: AttachCoords = {
        tmux_session: row.tmux_session!, tmux_window: row.tmux_window!, tmux_pane: row.tmux_pane, tmux_socket: row.tmux_socket,
      };
      if (where === "new-tab" || where === "new-terminal") return openTerminal(where, row);
      if (where === "new-session") {
        const name = groupedSessionName(row.session_id);
        const exists = await sessionExists(name, row.tmux_socket);
        for (const args of buildGroupedSessionCommands(coords, name, exists)) await deps.runTmux(args);
        return opened();
      }
      if (where === "new-pane" || where === "new-window") {
        const here = await currentPane();
        const sameSession = !!here && (here.socket ?? null) === (row.tmux_socket ?? null) && here.session === row.tmux_session;
        // A view of the caller's own session would show itself — go there inline instead.
        if (here && !sameSession) {
          const view = buildViewClientArgv(coords, viewSessionName(row.session_id, now()), settings.viewDetachKey);
          const hs = tmuxSocketArgs(here.socket);
          await deps.runTmux(where === "new-pane"
            ? [...hs, "split-window", "-t", here.pane, "--", ...view]
            : [...hs, "new-window", "-t", `${here.session}:`, "-n", `view:${row.session_id.slice(0, 8)}`, "--", ...view]);
          return opened();
        }
      }
      // inline (today's behaviour)
      if (popup) return attachInPopup(coords, deps.runTmux);
      const cmds = buildAttachCommands(coords, inTmux);
      if (inTmux) { for (const args of cmds) await deps.runTmux(args); return null; }
      return { argv: ["tmux", ...cmds[0]!] };
    },
```
Keep `kill`, `resume` (now the function above), `copy`, `markSeen` members as they are. Remove the old inner `resume` function and the old `LIVE_STATUSES` import if it becomes unused.

`packages/cli/src/attach-place.ts` — append:
```ts
import { loadAttachConfig } from "@agmux/wrapper";

// [attach]/[terminal] from config.toml + the agmux binary a new terminal should run.
export function loadAttachSettings(configPath: string): AttachSettings {
  const bin = process.env.AGMUX_BIN ?? Bun.which("agmux") ?? "agmux";
  return attachSettingsFrom(loadAttachConfig(configPath), bin);
}
```
(move the import to the top of the file with the others.)

`packages/cli/src/dash.ts`:
- `DashCmdDeps.makeActionsImpl: (hubUrl: string, wrapBin: string, popup: boolean, settings: AttachSettings) => Actions;`
- `defaultDeps.makeActionsImpl: (h, w, p, s) => makeActions(h, w, p, undefined, s)`
- `dashCmd` opts type gains `attach?: AttachSettings`; inside:
  ```ts
  const attach = opts.attach ?? DEFAULT_ATTACH_SETTINGS;
  ```
  and the `runManageImpl({ … })` call gains
  ```ts
  actions: deps.makeActionsImpl(opts.hubUrl, opts.wrapBin, opts.popup, attach),
  attachCtx: attachCtxFor(attach, process.env, opts.popup),
  ```
  (replacing the existing `actions:` line). Import `attachCtxFor, DEFAULT_ATTACH_SETTINGS, type AttachSettings` from `./attach-place.ts`.

`packages/cli/bin/agmux.ts` `dash` case — after loading `dashDefaults`:
```ts
let attachSettings: AttachSettings;
try { attachSettings = loadAttachSettings(configPath); }
catch (e) { console.error(e instanceof Error ? e.message : String(e)); return 2; }
```
and pass `attach: attachSettings` into `dashCmd({ … })`. Import `loadAttachSettings, type AttachSettings` from `../src/attach-place.ts`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/cli && bun run typecheck`
Expected: PASS, including every pre-existing `dash-actions` test (gone-session fallback, popup attach, resumeIntoSession).

- [ ] **Step 5: Manual check in tmux** (record results in the PR description; failures here are findings for the spec's Verify list, not blockers for the commit)

```bash
bun run build && ln -sf "$PWD/packages/cli/dist/agmux" /tmp/agmux-dev   # or the repo's usual dev binary path
```
Inside tmux, with a live agent in another tmux session: `/tmp/agmux-dev dash` → `A` → `3` (new window). Check: the window shows the agent; typing reaches the agent; no second status bar; `M-d` closes the client and `tmux ls` no longer lists `agmux-view-*`; the agent keeps running. Repeat with `2` (new pane) and `4` (new session; switch away, then `tmux ls` shows no `agmux-<id8>`).

- [ ] **Step 6: Commit**

```bash
git add packages/cli
git commit -m "feat(dash): open sessions in a new pane, window, session or terminal"
```

---

### Task 6: `agmux attach --placement`, docs

**Files:**
- Create: `packages/cli/src/attach-placed.ts`
- Modify: `packages/cli/bin/agmux.ts` (`attach` case)
- Modify: `packages/cli/src/usage.ts`
- Modify: `README.md` (dash keys + new config block), `CHANGELOG.md` (`[Unreleased]` → `Added`), `packages/tui/AGENTS.md`
- Test: `packages/cli/tests/attach-placed.test.ts`

**Interfaces:**
- Consumes: `makeActions` (Task 5), `attachKind` (Task 2), `isAttachPlacement` / `ATTACH_PLACEMENTS` (Task 1), `loadAttachSettings` (Task 5), `resolvePrefix` (`id-resolve.ts`), `postSeen` (`seen.ts`).
- Produces: `attachPlacedCmd(opts: { idOrPrefix: string; hubUrl: string; wrapBin: string; placement: AttachPlacement; settings: AttachSettings }, deps?: { makeActionsImpl?: typeof makeActions; spawn?: (h: Handoff) => Promise<number>; err?: (s: string) => void }): Promise<number>`.

- [ ] **Step 1: Write the failing test**

`packages/cli/tests/attach-placed.test.ts`:
```ts
import { test, expect } from "bun:test";
import type { SessionRow } from "@agmux/protocol";
import type { Actions, AttachRequest } from "@agmux/tui";
import { attachPlacedCmd } from "../src/attach-placed.ts";
import { DEFAULT_ATTACH_SETTINGS } from "../src/attach-place.ts";

const ID = "019f1898-8e0f-7000-ab55-07d09f673b59";
function row(over: Partial<SessionRow> = {}): SessionRow {
  return {
    session_id: ID, agent_kind: "claude", profile: null, native_session_id: null,
    command: "claude", args: [], env_overrides: {}, cwd: "/tmp", pid: 1,
    tmux_session: "work", tmux_window: "@3", tmux_pane: "%5", tmux_socket: null,
    host: "h", project: null, parent_session_id: null,
    start_ts: "2026-10-09T10:00:00.000Z", last_heartbeat_ts: null,
    end_ts: null, exit_code: null, signal: null, status: "running", origin: "native", ...over,
  };
}

async function withHub<T>(session: SessionRow, fn: () => Promise<T>): Promise<T> {
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (init?.method === "POST") return new Response(null, { status: 202 });
    if (u.includes("/sessions?")) return new Response(JSON.stringify({ sessions: [session] }));
    return new Response(JSON.stringify({ session, usage: null }));
  }) as unknown as typeof fetch;
  try { return await fn(); } finally { globalThis.fetch = orig; }
}

function fakeActions(log: string[]): Actions {
  return {
    async attach(_r, req?: AttachRequest) { log.push(`attach:${req?.placement}`); return { argv: ["tmux", "attach"] }; },
    async resume(_r, req?: AttachRequest) { log.push(`resume:${req?.placement}`); return null; },
    async kill() {}, async copy() {}, async markSeen() {},
  };
}

test("a live session is attached with the requested placement and the handoff runs", async () => {
  const log: string[] = [];
  const ran: string[][] = [];
  const code = await withHub(row(), () => attachPlacedCmd(
    { idOrPrefix: "019f", hubUrl: "http://hub", wrapBin: "w", placement: "inline", settings: DEFAULT_ATTACH_SETTINGS },
    { makeActionsImpl: () => fakeActions(log), spawn: async (h) => { ran.push(h.argv); return 0; } },
  ));
  expect(code).toBe(0);
  expect(log).toEqual(["attach:inline"]);
  expect(ran).toEqual([["tmux", "attach"]]);
});

test("a closed session is resumed with the requested placement", async () => {
  const log: string[] = [];
  const code = await withHub(row({ status: "lost" }), () => attachPlacedCmd(
    { idOrPrefix: "019f", hubUrl: "http://hub", wrapBin: "w", placement: "new-window", settings: DEFAULT_ATTACH_SETTINGS },
    { makeActionsImpl: () => fakeActions(log), spawn: async () => 0 },
  ));
  expect(code).toBe(0);
  expect(log).toEqual(["resume:new-window"]);
});

test("an unavailable placement prints its reason and exits 2", async () => {
  const errs: string[] = [];
  const throwing: Actions = { ...fakeActions([]), async attach() { throw new Error("new pane: not in tmux"); } };
  const code = await withHub(row(), () => attachPlacedCmd(
    { idOrPrefix: "019f", hubUrl: "http://hub", wrapBin: "w", placement: "new-pane", settings: DEFAULT_ATTACH_SETTINGS },
    { makeActionsImpl: () => throwing, spawn: async () => 0, err: (s) => errs.push(s) },
  ));
  expect(code).toBe(2);
  expect(errs).toEqual(["attach: new pane: not in tmux"]);
});

test("a live session without tmux coords is an error", async () => {
  const errs: string[] = [];
  const code = await withHub(row({ tmux_session: null, tmux_window: null }), () => attachPlacedCmd(
    { idOrPrefix: "019f", hubUrl: "http://hub", wrapBin: "w", placement: "inline", settings: DEFAULT_ATTACH_SETTINGS },
    { makeActionsImpl: () => fakeActions([]), spawn: async () => 0, err: (s) => errs.push(s) },
  ));
  expect(code).toBe(1);
  expect(errs).toEqual(["attach: session has no tmux pane"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/cli/tests/attach-placed.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`packages/cli/src/attach-placed.ts`:
```ts
// `agmux attach <id> --placement <p>`: the dash's placement executor on the CLI.
// Lives apart from attach.ts because dash-actions.ts already imports attach.ts.
import type { AttachPlacement, SessionRow } from "@agmux/protocol";
import { attachKind, type Handoff } from "@agmux/tui";
import { makeActions } from "./dash-actions.ts";
import { resolvePrefix } from "./id-resolve.ts";
import { postSeen } from "./seen.ts";
import type { AttachSettings } from "./attach-place.ts";

export interface AttachPlacedOpts {
  idOrPrefix: string; hubUrl: string; wrapBin: string; placement: AttachPlacement; settings: AttachSettings;
}

export interface AttachPlacedDeps {
  makeActionsImpl?: typeof makeActions;
  spawn?: (h: Handoff) => Promise<number>;
  err?: (s: string) => void;
}

async function spawnForeground(h: Handoff): Promise<number> {
  const child = Bun.spawn(h.argv, { stdio: ["inherit", "inherit", "inherit"], env: h.env ?? process.env });
  await child.exited;
  return child.exitCode ?? 0;
}

export async function attachPlacedCmd(opts: AttachPlacedOpts, deps: AttachPlacedDeps = {}): Promise<number> {
  const err = deps.err ?? ((s: string) => console.error(s));
  const listR = await fetch(`${opts.hubUrl}/sessions?all=1&limit=1000`);
  if (!listR.ok) { err(`hub error ${listR.status}`); return 1; }
  const { sessions } = (await listR.json()) as { sessions: SessionRow[] };
  const res = resolvePrefix(opts.idOrPrefix, sessions.map((s) => s.session_id));
  if (!res.ok) { err(res.error); return 2; }
  const { session } = (await (await fetch(`${opts.hubUrl}/sessions/${res.id}`)).json()) as { session: SessionRow };

  const kind = attachKind(session);
  if (kind === "none") { err("attach: session has no tmux pane"); return 1; }

  // Same bookkeeping as plain `agmux attach`: opening a session marks it seen.
  void postSeen(session.session_id, "attach", {
    hubUrl: opts.hubUrl, host: session.host,
    fetchImpl: fetch, now: () => new Date().toISOString(), newId: () => crypto.randomUUID(),
  }).catch(() => {});

  const actions = (deps.makeActionsImpl ?? makeActions)(opts.hubUrl, opts.wrapBin, false, undefined, opts.settings);
  const req = { placement: opts.placement };
  let h: Handoff | null;
  try {
    h = kind === "closed" ? await actions.resume(session, req) : await actions.attach(session, req);
  } catch (e) {
    err(`attach: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  return h && h.argv.length > 0 ? (deps.spawn ?? spawnForeground)(h) : 0;
}
```
(Check `resolvePrefix`'s actual return shape in `packages/cli/src/id-resolve.ts` — `attach.ts` uses `res.ok` / `res.error` / `res.id`, so mirror that.)

`packages/cli/bin/agmux.ts` — replace the `attach` case:
```ts
case "attach": {
  const id = argv[1]; if (!id || id.startsWith("--")) usage();
  const pi = argv.indexOf("--placement");
  if (pi < 0) return attachCmd({ idOrPrefix: id, hubUrl, wrapBin });
  const placement = argv[pi + 1];
  if (!isAttachPlacement(placement)) {
    console.error(`attach: --placement must be one of ${ATTACH_PLACEMENTS.join("|")}`);
    return 2;
  }
  const configPath = path.join(os.homedir(), AGMUX_CONFIG_SUBPATH);
  let settings: AttachSettings;
  try { settings = loadAttachSettings(configPath); }
  catch (e) { console.error(e instanceof Error ? e.message : String(e)); return 2; }
  return attachPlacedCmd({ idOrPrefix: id, hubUrl, wrapBin, placement, settings });
}
```
Imports: `isAttachPlacement, ATTACH_PLACEMENTS` from `@agmux/protocol`; `attachPlacedCmd` from `../src/attach-placed.ts`.

`packages/cli/src/usage.ts` — replace the `  attach <id|prefix>` line with:
```
  attach <id|prefix> [--placement <inline|new-pane|new-window|new-session|new-tab|new-terminal>]
     open a session; without --placement: switch to it (live) or resume it.
     placement defaults and terminal templates: [attach] / [terminal] in config.toml
```

`README.md` — in the `dash` keys paragraph add `` `A` attach to… (pick where it opens) `` after `` `⏎` attach (switch-client) ``; after the `[dash]` config block add:

````markdown
`A` lists every place a session can open — `1` inline · `2` new pane · `3` new window ·
`4` new session · `5` peek (planned) · `6` new tab · `7` new terminal window. Unavailable
ones stay in their slot, dimmed, with the reason. A live session in a new pane/window is
shown through a throw-away tmux client (`M-d` closes it; the agent keeps running). ⏎ uses
the defaults below; `agmux attach <id> --placement <p>` does the same from a shell.

```toml
[attach]
live = "inline"          # ⏎ on a live session
closed = "new-window"    # ⏎ on a closed session (resume); outside tmux: inline
view_detach_key = "M-d"  # closes a new-pane/new-window view

[terminal]               # unset → "new tab" / "new terminal window" are dimmed
new_window = ["open", "-na", "Ghostty.app", "--args", "-e", "{cmd}"]
new_tab = []
```
````

`CHANGELOG.md` `[Unreleased]` → `### Added`:
```markdown
- dash: `A` opens an attach-target popup — inline, new pane, new window, new tmux
  session, new terminal tab/window. ⏎ defaults via `[attach] live` / `closed`;
  terminal launch templates via `[terminal] new_window` / `new_tab`.
  `agmux attach --placement <p>` exposes the same targets.
```

`packages/tui/AGENTS.md` — in "Look & feel rules" change `(\`Overlays.tsx\`: help, yank)` to `(\`Overlays.tsx\`: help, yank, attach — the two pickers share \`PickerOverlay\`)`; append:
```markdown
## Attach targets (`shared/attach-targets.ts`)

`ATTACH_PLACEMENTS` (`@agmux/protocol`) is the slot order of the `A` popup; `attachTargets(kind, ctx)` says which are available and why not; `defaultPlacement` / `resolvePlacement` are what ⏎ and `agmux attach --placement` use, so popup and cli always agree. The cli side (tmux/terminal argv) is `cli/src/attach-place.ts`, executed in `cli/src/dash-actions.ts`.

### Adding a placement

1. Append (never insert) to `ATTACH_PLACEMENTS`; add its label to `LABELS` and its availability rule to `reasonFor`.
2. Build its argv as a pure function in `cli/src/attach-place.ts` (tested), execute it in `makeActions` (`attach` for live, `resume` for closed).
3. Update the README slot list and `usage.ts`.
```

- [ ] **Step 4: Run all checks**

Run: `bun test && bun run typecheck`
Expected: all pass (916 + new tests), typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/cli README.md CHANGELOG.md packages/tui/AGENTS.md
git commit -m "feat(attach): --placement flag; document the attach popup"
```
