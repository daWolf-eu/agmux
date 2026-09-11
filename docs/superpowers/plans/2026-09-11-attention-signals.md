# Attention Signals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give agmux an always-visible tmux status line of live agent sessions, plus debounced, focus-aware notifications when a session needs you.

**Architecture:** One long-running consumer (`agmux notifyd`) subscribes to the existing polling `SessionFeed` over the hub query API. It renders a tmux-format string to an atomically-written cache file that `status-format[1]` reads via `#(cat)`, and it detects `running→waiting` transitions to drive two notification sinks (tmux `display-message`, and a native OS notifier resolved at runtime). Read/unread is a `session.seen` event with a rebuildable projection, never a mutable flag.

**Tech Stack:** TypeScript on Bun ≥ 1.3, `bun:sqlite`, `bun test`, tmux ≥ 3.2, smol-toml. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-11-attention-signals-design.md`

## Global Constraints

- **Branch:** all work lands on `feat/attention-signals`. The feature merges once, whole — stages are commit structure, not releases.
- **tmux floor stays 3.2.** Multi-line status needs 3.3; below that fall back to `status-right`. Never bump the README floor.
- **No new package.** Pure logic goes in `@agmux/tui/src/shared/`, commands in `@agmux/cli/src/`.
- **Never treat a notifier's exit 0 as proof of delivery.** `osascript` returns 0 when suppressed.
- **Never take over the screen.** No `display-popup`, no OSC 9/777, no window creation for notification purposes.
- **The plugin never sets a global tmux option the user did not ask for** (notably `allow-passthrough`).
- **Shell-outs are injected** behind a `RunCmd` seam. Tests assert argv; they never execute `tmux`, `osascript`, or `terminal-notifier`.
- **`bun test` and `bun run typecheck` must be green at the end of every task.**
- Glyphs come from the existing `statusGlyph` in `packages/tui/src/shared/glyph.ts`. Do not invent new glyphs or colors.
- Bump `packages/protocol/src/version.ts` and add a `CHANGELOG.md` entry (Task 13 only).

---

## File Structure

**Create:**
- `packages/tui/src/shared/statusline.ts` — pure row list → tmux-format string.
- `packages/tui/src/shared/transitions.ts` — pure transition/debounce detection.
- `packages/cli/src/attention-config.ts` — parse `[statusline]` / `[notify]` from config.toml.
- `packages/cli/src/notifier.ts` — notifier resolution + argv construction.
- `packages/cli/src/statusline-cmd.ts` — `agmux statusline` one-shot.
- `packages/cli/src/notifyd.ts` — the daemon.
- `packages/cli/src/seen.ts` — `agmux seen` / `--unseen`.
- Tests mirroring each of the above under the owning package's `tests/`.

**Modify:**
- `packages/protocol/src/session.ts` — `unread` on `SessionRow`.
- `packages/protocol/src/events.ts` — `session.seen` kind + payload.
- `packages/store/src/schema.ts`, `migrations.ts`, `project.ts`, `queries.ts`, `index.ts` — schema v6, projection, unread.
- `packages/hub/src/server.ts` — `?unread=1`.
- `packages/cli/src/index.ts` — command dispatch.
- `packages/cli/src/attach.ts` — emit `session.seen` on attach.
- `packages/tui/src/opentui/DashApp.tsx` — mark read/unread keys.
- `agmux.tmux` — options and bindings.

---

## Task 1: Status line formatter

**Files:**
- Create: `packages/tui/src/shared/statusline.ts`
- Test: `packages/tui/tests/shared/statusline.test.ts`

**Interfaces:**
- Consumes: `statusGlyph` from `./glyph.ts`, `SessionRow` from `@agmux/protocol`.
- Produces: `formatStatusLine(rows, opts): string`, `abbreviate(s, max): string`, `StatusLineOpts`, `ShowMode`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/tui/tests/shared/statusline.test.ts
import { test, expect } from "bun:test";
import { formatStatusLine, abbreviate, type StatusLineOpts } from "../../src/shared/statusline.ts";
import { mkRow } from "../helpers/mk-row.ts";

const OPTS: StatusLineOpts = { show: "all", max: 6, format: "{glyph} {tmux_session}:{tmux_window}" };

test("renders one entry with glyph colour and tmux coords", () => {
  const rows = [mkRow({ session_id: "agx-1", status: "running", tmux_session: "work", tmux_window: "2" })];
  expect(formatStatusLine(rows, OPTS)).toBe("#[range=user|agx-1]#[fg=#a6e3a1]● work:2#[default]#[norange]");
});

test("separates multiple entries with two spaces", () => {
  const rows = [
    mkRow({ session_id: "a", status: "running", tmux_session: "w", tmux_window: "1" }),
    mkRow({ session_id: "b", status: "waiting", tmux_session: "w", tmux_window: "2" }),
  ];
  const out = formatStatusLine(rows, OPTS);
  expect(out).toContain("#[fg=#a6e3a1]● w:1#[default]#[norange]  #[range=user|b]");
});

test("null fields collapse the separator rather than leaving a dangling colon", () => {
  const rows = [mkRow({ session_id: "a", status: "idle", tmux_session: "w", tmux_window: null })];
  expect(formatStatusLine(rows, OPTS)).toContain("○ w");
  expect(formatStatusLine(rows, OPTS)).not.toContain("w:");
});

test("show=waiting keeps only waiting rows", () => {
  const rows = [mkRow({ session_id: "a", status: "running" }), mkRow({ session_id: "b", status: "waiting" })];
  expect(formatStatusLine(rows, { ...OPTS, show: "waiting" })).toContain("range=user|b");
  expect(formatStatusLine(rows, { ...OPTS, show: "waiting" })).not.toContain("range=user|a");
});

test("show=unread keeps only unread rows", () => {
  const rows = [mkRow({ session_id: "a", unread: false }), mkRow({ session_id: "b", unread: true })];
  expect(formatStatusLine(rows, { ...OPTS, show: "unread" })).not.toContain("range=user|a");
  expect(formatStatusLine(rows, { ...OPTS, show: "unread" })).toContain("range=user|b");
});

test("overflow past max collapses to a +N chip", () => {
  const rows = Array.from({ length: 5 }, (_, i) => mkRow({ session_id: `s${i}`, tmux_session: "w", tmux_window: String(i) }));
  expect(formatStatusLine(rows, { ...OPTS, max: 3 })).toContain("+2");
});

test("empty row list renders an empty string, not a stray separator", () => {
  expect(formatStatusLine([], OPTS)).toBe("");
});

test("abbreviate truncates from the middle, keeping the suffix legible", () => {
  expect(abbreviate("very-long-session-name-7", 12)).toBe("very…name-7");
  expect(abbreviate("short", 12)).toBe("short");
});

test("format string honours other placeholders", () => {
  const rows = [mkRow({ session_id: "agx-abcdef123", status: "running", agent_kind: "codex", project: "agmux" })];
  const out = formatStatusLine(rows, { ...OPTS, format: "{agent_kind}/{project} {status}" });
  expect(out).toContain("codex/agmux running");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/tui/tests/shared/statusline.test.ts`
Expected: FAIL — cannot resolve `../../src/shared/statusline.ts`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/tui/src/shared/statusline.ts
import type { SessionRow } from "@agmux/protocol";
import { statusGlyph } from "./glyph.ts";

export type ShowMode = "all" | "unread" | "waiting";

export interface StatusLineOpts {
  show: ShowMode;
  max: number;
  format: string;
  /** Abbreviation budget for {tmux_session}. */
  sessionWidth?: number;
}

// Middle-truncate: a numeric or branch-like suffix is the discriminating part,
// so dropping the middle keeps far more signal than a trailing ellipsis would.
export function abbreviate(s: string, max: number): string {
  if (s.length <= max) return s;
  if (max <= 1) return "…";
  const head = Math.ceil((max - 1) / 2);
  const tail = max - 1 - head;
  return s.slice(0, head) + "…" + (tail > 0 ? s.slice(s.length - tail) : "");
}

function visible(rows: SessionRow[], show: ShowMode): SessionRow[] {
  if (show === "waiting") return rows.filter((r) => r.status === "waiting");
  if (show === "unread") return rows.filter((r) => r.unread === true);
  return rows;
}

function shortId(id: string): string {
  return id.length <= 8 ? id : id.slice(-8);
}

function fieldValue(r: SessionRow, key: string, sessionWidth: number): string {
  switch (key) {
    case "glyph": return statusGlyph(r).glyph;
    case "tmux_session": return r.tmux_session ? abbreviate(r.tmux_session, sessionWidth) : "";
    case "tmux_window": return r.tmux_window ?? "";
    case "tmux_pane": return r.tmux_pane ?? "";
    case "project": return r.project ?? "";
    case "agent_kind": return r.agent_kind;
    case "status": return r.status;
    case "session_id": return shortId(r.session_id);
    case "last_tool": return r.last_tool ?? "";
    default: return "";
  }
}

// Substitute placeholders, then collapse separators orphaned by an empty field:
// "{a}:{b}" with b empty must render "a", never "a:".
function renderFormat(r: SessionRow, format: string, sessionWidth: number): string {
  const out = format.replace(/\{(\w+)\}/g, (_m, key: string) => fieldValue(r, key, sessionWidth));
  return out
    .replace(/[:/]+(?=\s|$)/g, "")
    .replace(/(^|\s)[:/]+/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function formatStatusLine(rows: SessionRow[], opts: StatusLineOpts): string {
  const sessionWidth = opts.sessionWidth ?? 12;
  const shown = visible(rows, opts.show);
  const head = shown.slice(0, Math.max(0, opts.max));
  const overflow = shown.length - head.length;

  const parts = head.map((r) => {
    const { color } = statusGlyph(r);
    const body = renderFormat(r, opts.format, sessionWidth);
    return `#[range=user|${r.session_id}]#[fg=${color}]${body}#[default]#[norange]`;
  });
  if (overflow > 0) parts.push(`#[fg=#6c7086]+${overflow}#[default]`);
  return parts.join("  ");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/tui/tests/shared/statusline.test.ts && bun run typecheck`
Expected: PASS. `unread` is not yet on `SessionRow`, so typecheck fails — add it now as part of this task:

```ts
// packages/protocol/src/session.ts — inside SessionRow, next to turn_count
  // Joined from the session_seen projection (see session_activity.attention_ts).
  // true = an attention-worthy event is newer than the last session.seen.
  unread?: boolean | null;
```

Also add `unread: null` to the `mkRow` defaults in `packages/tui/tests/helpers/mk-row.ts`.

Re-run: `bun test packages/tui/tests/shared/statusline.test.ts && bun run typecheck` → PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/tui/src/shared/statusline.ts packages/tui/tests/shared/statusline.test.ts \
        packages/protocol/src/session.ts packages/tui/tests/helpers/mk-row.ts
git commit -m "feat(tui): status line formatter for tmux status-format"
```

---

## Task 2: Attention config parsing

**Files:**
- Create: `packages/cli/src/attention-config.ts`
- Test: `packages/cli/tests/attention-config.test.ts`

**Interfaces:**
- Consumes: `parse` from `smol-toml` (already a dependency of `@agmux/wrapper`; add to `@agmux/cli` package.json dependencies).
- Produces: `loadAttentionConfig(toml: string): AttentionConfig`, `parseDuration(v: unknown): number`, types `AttentionConfig`, `StatuslineConfig`, `NotifyConfig`, `NotifyTrigger`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/tests/attention-config.test.ts
import { test, expect } from "bun:test";
import { loadAttentionConfig, parseDuration } from "../src/attention-config.ts";

test("empty config yields documented defaults", () => {
  const c = loadAttentionConfig("");
  expect(c.notify.enabled).toBe(true);
  expect(c.notify.delayMs).toBe(5000);
  expect(c.notify.soundName).toBe("Ping");
  expect(c.notify.command).toBe("auto");
  expect(c.statusline.show).toBe("all");
  expect(c.statusline.max).toBe(6);
  expect(c.statusline.position).toBe("status2");
  expect(c.statusline.format).toBe("{glyph} {tmux_session}:{tmux_window}");
});

test("parses durations in both forms", () => {
  expect(parseDuration("5s")).toBe(5000);
  expect(parseDuration("2m")).toBe(120000);
  expect(parseDuration(30)).toBe(30000);
  expect(parseDuration("0")).toBe(0);
});

test("an unparseable duration throws rather than silently disabling the debounce", () => {
  expect(() => parseDuration("soon")).toThrow(/duration/i);
  expect(() => loadAttentionConfig(`[notify]\ndelay = "soon"\n`)).toThrow(/duration/i);
});

test("overrides replace defaults", () => {
  const c = loadAttentionConfig(`
[notify]
delay = "20s"
triggers = ["permission"]
sound = false

[notify.sounds]
permission = "Sosumi"

[statusline]
show = "unread"
max = 3
position = "status-right"
`);
  expect(c.notify.delayMs).toBe(20000);
  expect(c.notify.triggers).toEqual(["permission"]);
  expect(c.notify.sound).toBe(false);
  expect(c.notify.sounds.permission).toBe("Sosumi");
  expect(c.statusline.show).toBe("unread");
  expect(c.statusline.max).toBe(3);
  expect(c.statusline.position).toBe("status-right");
});

test("an unknown trigger or show mode is rejected by name", () => {
  expect(() => loadAttentionConfig(`[notify]\ntriggers = ["explode"]\n`)).toThrow(/explode/);
  expect(() => loadAttentionConfig(`[statusline]\nshow = "sideways"\n`)).toThrow(/sideways/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/cli/tests/attention-config.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/cli/src/attention-config.ts
import { parse as parseToml } from "smol-toml";

export const NOTIFY_TRIGGERS = ["permission", "prompt", "turn_end", "session_end"] as const;
export type NotifyTrigger = (typeof NOTIFY_TRIGGERS)[number];

export const SHOW_MODES = ["all", "unread", "waiting"] as const;
export type ShowMode = (typeof SHOW_MODES)[number];

export const POSITIONS = ["status2", "status-right", "off"] as const;
export type Position = (typeof POSITIONS)[number];

export interface NotifyConfig {
  enabled: boolean;
  delayMs: number;
  triggers: NotifyTrigger[];
  sound: boolean;
  soundName: string;
  sounds: Partial<Record<NotifyTrigger, string>>;
  command: string;
  tmuxMessage: boolean;
  suppressWhenVisible: boolean;
}

export interface StatuslineConfig {
  enabled: boolean;
  position: Position;
  show: ShowMode;
  max: number;
  format: string;
  sort: "started" | "activity";
}

export interface AttentionConfig { notify: NotifyConfig; statusline: StatuslineConfig; }

// "5s" | "2m" | 30 (bare = seconds). Throws on anything else: silently falling
// back to 0 would turn the debounce off without telling anyone.
export function parseDuration(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v) && v >= 0) return Math.round(v * 1000);
  if (typeof v === "string") {
    const m = /^(\d+(?:\.\d+)?)(ms|s|m)?$/.exec(v.trim());
    if (m) {
      const n = Number(m[1]);
      const unit = m[2] ?? "s";
      const mult = unit === "ms" ? 1 : unit === "m" ? 60000 : 1000;
      return Math.round(n * mult);
    }
  }
  throw new Error(`invalid duration: ${JSON.stringify(v)} (expected "5s", "2m", or a number of seconds)`);
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string, fallback: T): T {
  if (value === undefined) return fallback;
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T;
  throw new Error(`invalid ${field}: ${String(value)} (expected one of ${allowed.join(", ")})`);
}

export function loadAttentionConfig(toml: string): AttentionConfig {
  const raw = (toml.trim() === "" ? {} : parseToml(toml)) as any;
  const n = (raw.notify ?? {}) as any;
  const s = (raw.statusline ?? {}) as any;

  const triggers: NotifyTrigger[] = Array.isArray(n.triggers)
    ? n.triggers.map((t: unknown) => oneOf(t, NOTIFY_TRIGGERS, "notify.triggers entry", "permission"))
    : [...NOTIFY_TRIGGERS];

  const sounds: Partial<Record<NotifyTrigger, string>> = {};
  for (const [k, v] of Object.entries((n.sounds ?? {}) as Record<string, unknown>)) {
    sounds[oneOf(k, NOTIFY_TRIGGERS, "notify.sounds key", "permission")] = String(v);
  }

  return {
    notify: {
      enabled: n.enabled ?? true,
      delayMs: n.delay === undefined ? 5000 : parseDuration(n.delay),
      triggers,
      sound: n.sound ?? true,
      soundName: n.sound_name ?? "Ping",
      sounds,
      command: n.command ?? "auto",
      tmuxMessage: n.tmux_message ?? true,
      suppressWhenVisible: n.suppress_when_visible ?? true,
    },
    statusline: {
      enabled: s.enabled ?? true,
      position: oneOf(s.position, POSITIONS, "statusline.position", "status2"),
      show: oneOf(s.show, SHOW_MODES, "statusline.show", "all"),
      max: typeof s.max === "number" ? s.max : 6,
      format: s.format ?? "{glyph} {tmux_session}:{tmux_window}",
      sort: oneOf(s.sort, ["started", "activity"] as const, "statusline.sort", "activity"),
    },
  };
}
```

Add `"smol-toml"` to `dependencies` in `packages/cli/package.json`, matching the version already pinned in `packages/wrapper/package.json`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/cli/tests/attention-config.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/attention-config.ts packages/cli/tests/attention-config.test.ts packages/cli/package.json
git commit -m "feat(cli): parse [notify] and [statusline] config sections"
```

---

## Task 3: `agmux statusline` one-shot command

**Files:**
- Create: `packages/cli/src/statusline-cmd.ts`
- Test: `packages/cli/tests/statusline-cmd.test.ts`
- Modify: `packages/cli/src/index.ts`

**Interfaces:**
- Consumes: `formatStatusLine`, `StatusLineOpts` (Task 1); `AttentionConfig` (Task 2).
- Produces: `statuslineCmd(opts, deps): Promise<number>`, `StatuslineCmdDeps`, `CACHE_REL_PATH`, `cachePath(env)`, `staleMarker()`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/tests/statusline-cmd.test.ts
import { test, expect } from "bun:test";
import { statuslineCmd, cachePath, type StatuslineCmdDeps } from "../src/statusline-cmd.ts";
import { loadAttentionConfig } from "../src/attention-config.ts";

function deps(over: Partial<StatuslineCmdDeps> = {}): StatuslineCmdDeps {
  return {
    fetchImpl: (async () => new Response(JSON.stringify({
      sessions: [{
        session_id: "agx-1", agent_kind: "claude", profile: null, native_session_id: null,
        command: "claude", args: [], env_overrides: {}, cwd: "/tmp", pid: 1,
        tmux_session: "work", tmux_window: "2", tmux_socket: null, tmux_pane: null,
        host: "h", project: null, parent_session_id: null, start_ts: "2026-09-11T10:00:00.000Z",
        last_heartbeat_ts: null, end_ts: null, exit_code: null, signal: null,
        status: "running", origin: "native",
      }],
    }), { status: 200 })) as unknown as typeof fetch,
    out: () => {},
    config: loadAttentionConfig(""),
    ...over,
  };
}

test("prints the rendered line to stdout", async () => {
  let printed = "";
  const code = await statuslineCmd({ hubUrl: "http://127.0.0.1:1" }, deps({ out: (s) => { printed = s; } }));
  expect(code).toBe(0);
  expect(printed).toContain("● work:2");
});

test("a hub error prints a dim marker and still exits 0", async () => {
  let printed = "";
  const code = await statuslineCmd(
    { hubUrl: "http://127.0.0.1:1" },
    deps({ fetchImpl: (async () => { throw new Error("refused"); }) as unknown as typeof fetch, out: (s) => { printed = s; } }),
  );
  expect(code).toBe(0);
  expect(printed).toContain("hub down");
});

test("exit code stays 0 so tmux never paints an error", async () => {
  const code = await statuslineCmd(
    { hubUrl: "http://127.0.0.1:1" },
    deps({ fetchImpl: (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch }),
  );
  expect(code).toBe(0);
});

test("cachePath honours XDG_RUNTIME_DIR, else falls back to ~/.cache", () => {
  expect(cachePath({ XDG_RUNTIME_DIR: "/run/u", HOME: "/h" })).toBe("/run/u/agmux/statusline");
  expect(cachePath({ HOME: "/h" })).toBe("/h/.cache/agmux/statusline");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/cli/tests/statusline-cmd.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/cli/src/statusline-cmd.ts
import * as path from "node:path";
import type { SessionRow } from "@agmux/protocol";
import { formatStatusLine } from "@agmux/tui";
import type { AttentionConfig } from "./attention-config.ts";

export interface StatuslineCmdDeps {
  fetchImpl: typeof fetch;
  out: (s: string) => void;
  config: AttentionConfig;
}

export function cachePath(env: Record<string, string | undefined>): string {
  const runtime = env.XDG_RUNTIME_DIR;
  if (runtime) return path.join(runtime, "agmux", "statusline");
  return path.join(env.HOME ?? "/tmp", ".cache", "agmux", "statusline");
}

export function staleMarker(text: string): string {
  return `#[fg=#6c7086]agmux: ${text}#[default]`;
}

// Always exits 0: this runs inside tmux's status-format expansion, where a
// non-zero exit or a thrown error just paints garbage into the user's status bar.
export async function statuslineCmd(
  opts: { hubUrl: string },
  deps: StatuslineCmdDeps,
): Promise<number> {
  const { show, max, format, sort } = deps.config.statusline;
  try {
    const q = new URLSearchParams({ status: "open", sort, order: "desc" });
    const res = await deps.fetchImpl(`${opts.hubUrl}/sessions?${q.toString()}`);
    if (!res.ok) { deps.out(staleMarker("hub down")); return 0; }
    const { sessions } = (await res.json()) as { sessions: SessionRow[] };
    deps.out(formatStatusLine(sessions, { show, max, format }));
  } catch {
    deps.out(staleMarker("hub down"));
  }
  return 0;
}
```

Export the formatter from the tui package index so `@agmux/tui` resolves it:

```ts
// packages/tui/src/index.ts — add alongside the existing exports
export { formatStatusLine, abbreviate, type StatusLineOpts, type ShowMode } from "./shared/statusline.ts";
```

Wire the command into `packages/cli/src/index.ts` following the existing dispatch pattern used for `watch`: read the user's config from `~/.config/agmux/config.toml` via `AGMUX_CONFIG_SUBPATH` (returning `loadAttentionConfig("")` when the file is absent), then call `statuslineCmd({ hubUrl }, { fetchImpl: fetch, out: (s) => console.log(s), config })`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/cli/tests/statusline-cmd.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/statusline-cmd.ts packages/cli/tests/statusline-cmd.test.ts \
        packages/cli/src/index.ts packages/tui/src/index.ts
git commit -m "feat(cli): agmux statusline one-shot renderer"
```

---

## Task 4: `agmux notifyd` daemon and atomic cache file

**Files:**
- Create: `packages/cli/src/notifyd.ts`
- Test: `packages/cli/tests/notifyd.test.ts`
- Modify: `packages/cli/src/index.ts`

**Interfaces:**
- Consumes: `PollingSessionFeed` from `@agmux/tui`, `formatStatusLine` (Task 1), `cachePath`/`staleMarker` (Task 3), `AttentionConfig` (Task 2).
- Produces: `writeLineAtomic(file, text, deps)`, `runNotifyd(opts, deps): Promise<number>`, `NotifydDeps`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/tests/notifyd.test.ts
import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeLineAtomic, isStale } from "../src/notifyd.ts";

test("writes via a temp file then renames, so a reader never sees a partial line", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agmux-sl-"));
  const target = path.join(dir, "nested", "statusline");
  const seen: string[] = [];
  writeLineAtomic(target, "hello", {
    mkdir: (d) => { seen.push(`mkdir:${d}`); fs.mkdirSync(d, { recursive: true }); },
    write: (f, t) => { seen.push(`write:${path.basename(f)}`); fs.writeFileSync(f, t); },
    rename: (a, b) => { seen.push("rename"); fs.renameSync(a, b); },
  });
  expect(seen[0]).toContain("mkdir:");
  expect(seen[1]).toContain("write:statusline.");   // temp sibling, not the target
  expect(seen[2]).toBe("rename");
  expect(fs.readFileSync(target, "utf8")).toBe("hello");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a write failure is swallowed — the daemon must not die over a cache file", () => {
  expect(() => writeLineAtomic("/nope/x", "hi", {
    mkdir: () => { throw new Error("EACCES"); },
    write: () => {}, rename: () => {},
  })).not.toThrow();
});

test("heartbeat staleness is judged against the configured interval", () => {
  const t0 = Date.parse("2026-09-11T10:00:00.000Z");
  expect(isStale("2026-09-11T10:00:02.000Z", t0 + 3000, 1000)).toBe(false);
  expect(isStale("2026-09-11T10:00:00.000Z", t0 + 30000, 1000)).toBe(true);
  expect(isStale(null, t0, 1000)).toBe(true);
  expect(isStale("not-a-date", t0, 1000)).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/cli/tests/notifyd.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/cli/src/notifyd.ts
import * as fs from "node:fs";
import * as path from "node:path";
import type { SessionRow } from "@agmux/protocol";
import { PollingSessionFeed, formatStatusLine } from "@agmux/tui";
import type { AttentionConfig } from "./attention-config.ts";
import { cachePath, staleMarker } from "./statusline-cmd.ts";

export interface AtomicFsDeps {
  mkdir: (dir: string) => void;
  write: (file: string, text: string) => void;
  rename: (from: string, to: string) => void;
}

const realFs: AtomicFsDeps = {
  mkdir: (d) => fs.mkdirSync(d, { recursive: true }),
  write: (f, t) => fs.writeFileSync(f, t),
  rename: (a, b) => fs.renameSync(a, b),
};

// Write temp-then-rename so a tmux client expanding #(cat ...) concurrently
// never reads a half-written line. Never throws: a cache-file problem must not
// take the daemon down.
export function writeLineAtomic(file: string, text: string, deps: AtomicFsDeps = realFs): void {
  try {
    deps.mkdir(path.dirname(file));
    const tmp = `${file}.${process.pid}.tmp`;
    deps.write(tmp, text);
    deps.rename(tmp, file);
  } catch { /* best-effort */ }
}

export function heartbeatPath(file: string): string {
  return `${file}.heartbeat`;
}

// A stale heartbeat means the daemon died while its last rendered line stayed on
// disk — without this, tmux would keep painting confident, frozen state. Ten
// missed ticks is the threshold: generous enough to survive a slow poll, short
// enough to notice a dead daemon.
export function isStale(heartbeat: string | null, now: number, intervalMs: number): boolean {
  if (!heartbeat) return true;
  const t = Date.parse(heartbeat);
  if (Number.isNaN(t)) return true;
  return now - t > Math.max(intervalMs * 10, 10000);
}

export interface NotifydDeps {
  env: Record<string, string | undefined>;
  config: AttentionConfig;
  fs?: AtomicFsDeps;
  makeFeed?: (hubUrl: string, query: URLSearchParams) => { subscribe: (
    onUpdate: (rows: SessionRow[]) => void, onError: (e: Error) => void) => () => void };
  onRows?: (rows: SessionRow[]) => void;   // sink hook; Task 12 attaches notifications here
  log?: (s: string) => void;
}

export async function runNotifyd(
  opts: { hubUrl: string; intervalMs?: number },
  deps: NotifydDeps,
): Promise<number> {
  const file = cachePath(deps.env);
  const { show, max, format, sort } = deps.config.statusline;
  const query = new URLSearchParams({ status: "open", sort, order: "desc" });

  const feed = deps.makeFeed
    ? deps.makeFeed(opts.hubUrl, query)
    : new PollingSessionFeed({ hubUrl: opts.hubUrl, query, intervalMs: opts.intervalMs ?? 1000 });

  const beat = () => writeLineAtomic(heartbeatPath(file), new Date().toISOString(), deps.fs);

  const unsubscribe = feed.subscribe(
    (rows) => {
      writeLineAtomic(file, formatStatusLine(rows, { show, max, format }), deps.fs);
      beat();
      deps.onRows?.(rows);
    },
    () => { writeLineAtomic(file, staleMarker("hub down"), deps.fs); beat(); },
  );

  await new Promise<void>((resolve) => {
    const stop = () => { unsubscribe(); resolve(); };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
  return 0;
}
```

Wire `notifyd` into `packages/cli/src/index.ts` dispatch, loading config the same way as Task 3.

Then add the staleness path to `packages/cli/src/statusline-cmd.ts` (built in Task 3), importing `heartbeatPath` and `isStale` from `./notifyd.ts`. Extend `StatuslineCmdDeps` with `readFile: (p: string) => string | null` and give `statuslineCmd` an `opts.check?: boolean`:

```ts
  // --check renders from the cache file rather than the hub, so tmux can show
  // that the daemon died instead of silently painting its last frozen line.
  if (opts.check) {
    const file = cachePath(deps.env);
    if (isStale(deps.readFile(heartbeatPath(file)), Date.now(), 1000)) {
      deps.out(staleMarker("stale"));
    } else {
      deps.out(deps.readFile(file) ?? "");
    }
    return 0;
  }
```

`StatuslineCmdDeps` also gains `env: Record<string, string | undefined>` for `cachePath`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/cli/tests/notifyd.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/notifyd.ts packages/cli/tests/notifyd.test.ts packages/cli/src/index.ts
git commit -m "feat(cli): notifyd daemon rendering the status line cache"
```

---

## Task 5: tmux plugin wiring

**Files:**
- Modify: `agmux.tmux`
- Test: `tests/agmux-tmux.test.ts` (create)

**Interfaces:**
- Consumes: `agmux statusline` / `agmux notifyd` (Tasks 3–4).
- Produces: shell functions `agmux_tmux_supports_status2`, `agmux_tmux_statusline_target` (sourced by the test with `AGMUX_TMUX_LIB_ONLY=1`).

- [ ] **Step 1: Write the failing test**

```ts
// tests/agmux-tmux.test.ts
import { test, expect } from "bun:test";

async function callFn(fn: string, args: string[], env: Record<string, string> = {}): Promise<string> {
  const p = Bun.spawn(["bash", "-c", `AGMUX_TMUX_LIB_ONLY=1 source ./agmux.tmux; ${fn} ${args.join(" ")}`], {
    env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe",
  });
  return (await new Response(p.stdout).text()).trim();
}

test("status2 requires tmux >= 3.3", async () => {
  expect(await callFn("agmux_tmux_supports_status2", ["3.3a"])).toBe("yes");
  expect(await callFn("agmux_tmux_supports_status2", ["3.6a"])).toBe("yes");
  expect(await callFn("agmux_tmux_supports_status2", ["3.2"])).toBe("no");
  expect(await callFn("agmux_tmux_supports_status2", ["2.9"])).toBe("no");
});

test("requested status2 downgrades to status-right below 3.3", async () => {
  expect(await callFn("agmux_tmux_statusline_target", ["status2", "3.6a"])).toBe("status2");
  expect(await callFn("agmux_tmux_statusline_target", ["status2", "3.2"])).toBe("status-right");
  expect(await callFn("agmux_tmux_statusline_target", ["status-right", "3.6a"])).toBe("status-right");
  expect(await callFn("agmux_tmux_statusline_target", ["off", "3.6a"])).toBe("off");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/agmux-tmux.test.ts`
Expected: FAIL — `agmux_tmux_supports_status2: command not found`.

- [ ] **Step 3: Write minimal implementation**

Add these functions to `agmux.tmux` **above** `main`, and guard the existing `main` invocation so sourcing the file for tests does not bind keys:

```bash
# Multi-line status (status-format[1]) landed in tmux 3.3. Below that we degrade
# to status-right, which is a graceful downgrade, not a broken feature — so the
# documented floor stays at 3.2.
agmux_tmux_supports_status2() {
  local v="${1:-}" major minor
  v="${v#tmux }"
  major="${v%%.*}"
  minor="${v#*.}"
  minor="${minor%%[!0-9]*}"
  [ -z "$minor" ] && minor=0
  if [ "$major" -gt 3 ] 2>/dev/null; then printf 'yes'; return; fi
  if [ "$major" -eq 3 ] 2>/dev/null && [ "$minor" -ge 3 ] 2>/dev/null; then printf 'yes'; return; fi
  printf 'no'
}

agmux_tmux_statusline_target() {
  local requested="${1:-status2}" version="${2:-}"
  case "$requested" in
    off) printf 'off'; return ;;
    status-right) printf 'status-right'; return ;;
  esac
  if [ "$(agmux_tmux_supports_status2 "$version")" = "yes" ]; then printf 'status2'; else printf 'status-right'; fi
}

agmux_tmux_install_statusline() {
  local bin="$1" position="$2" interval="$3" mouse="$4"
  local cache="${XDG_RUNTIME_DIR:-$HOME/.cache}/agmux/statusline"
  [ -n "${XDG_RUNTIME_DIR:-}" ] || cache="$HOME/.cache/agmux/statusline"
  local target
  target="$(agmux_tmux_statusline_target "$position" "$(tmux -V)")"
  [ "$target" = "off" ] && return 0
  if [ "$target" = "status-right" ] && [ "$position" = "status2" ]; then
    tmux display-message "agmux: tmux $(tmux -V) has no multi-line status; using status-right"
  fi
  tmux set-option -g status-interval "$interval"
  if [ "$target" = "status2" ]; then
    tmux set-option -g status 2
    tmux set-option -g 'status-format[1]' "#(cat '$cache' 2>/dev/null)"
  else
    tmux set-option -g status-right "#(cat '$cache' 2>/dev/null)"
  fi
  if [ "$mouse" = "on" ]; then
    # An empty mouse_status_range means the click landed outside every range —
    # no-op rather than attaching to something arbitrary.
    tmux bind-key -T root MouseDown1Status run-shell \
      "if [ -n '#{mouse_status_range}' ]; then $bin attach '#{mouse_status_range}'; fi"
  fi
}
```

Extend `main` to read the new options and call the installer:

```bash
  statusline="$(tmux_get "@agmux-statusline" "off")"
  position="$(tmux_get "@agmux-statusline-position" "status2")"
  interval="$(tmux_get "@agmux-statusline-interval" "2")"
  mouse="$(tmux_get "@agmux-statusline-mouse" "on")"
  if [ "$statusline" = "on" ]; then
    agmux_tmux_install_statusline "$bin" "$position" "$interval" "$mouse"
  fi
```

Guard the bottom of the file:

```bash
[ -n "${AGMUX_TMUX_LIB_ONLY:-}" ] || main
```

(Replacing the existing bare `main` call.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/agmux-tmux.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agmux.tmux tests/agmux-tmux.test.ts
git commit -m "feat(tmux): status line options with status-right fallback below 3.3"
```

---

## Task 6: `session.seen` event type

**Files:**
- Modify: `packages/protocol/src/events.ts`, `packages/protocol/src/validators.ts`
- Test: `packages/protocol/tests/session-seen.test.ts` (create)

**Interfaces:**
- Produces: `SessionSeenPayload { source: "attach" | "dismiss" }`, `SessionSeenEvent` (kind `"session.seen"`).

- [ ] **Step 1: Write the failing test**

```ts
// packages/protocol/tests/session-seen.test.ts
import { test, expect } from "bun:test";
import { validateKnownPayload } from "../src/validators.ts";

test("accepts a well-formed session.seen payload", () => {
  expect(validateKnownPayload("session.seen", { source: "attach" }).ok).toBe(true);
  expect(validateKnownPayload("session.seen", { source: "dismiss" }).ok).toBe(true);
});

test("rejects an unknown source", () => {
  expect(validateKnownPayload("session.seen", { source: "telepathy" }).ok).toBe(false);
});

test("rejects a missing source", () => {
  expect(validateKnownPayload("session.seen", {}).ok).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/protocol/tests/session-seen.test.ts`
Expected: FAIL — `session.seen` is treated as unknown, so validation passes when the test expects a rejection.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/protocol/src/events.ts — add next to the other payloads
// Marks a session acknowledged by the user. "unseen" is expressed as a later
// attention event, not as a delete — the log is append-only (foundation §14.3).
export interface SessionSeenPayload {
  source: "attach" | "dismiss";
}
export type SessionSeenEvent = EventEnvelope<SessionSeenPayload> & { kind: "session.seen" };
```

In `packages/protocol/src/validators.ts`, add a `session.seen` branch to the same `switch (kind)` the other kinds use:

```ts
    case "session.seen": {
      const p = payload as any;
      if (p?.source !== "attach" && p?.source !== "dismiss")
        return { ok: false, error: "session.seen: source must be 'attach' or 'dismiss'" };
      return { ok: true };
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/protocol/tests/session-seen.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/events.ts packages/protocol/src/validators.ts packages/protocol/tests/session-seen.test.ts
git commit -m "feat(protocol): session.seen event kind"
```

---

## Task 7: Schema v6, `attention_ts`, and the `session_seen` projection

**Files:**
- Modify: `packages/store/src/schema.ts`, `migrations.ts`, `project.ts`, `queries.ts`, `index.ts`
- Test: `packages/store/tests/unread.test.ts` (create)

**Interfaces:**
- Consumes: `SessionSeenPayload` (Task 6).
- Produces: `session_seen(session_id, seen_ts)` table; `session_activity.attention_ts` column; `unread` on every `SessionRow` returned by `listSessions`.

> **Design correction, applied here.** The spec says unread derives from
> `session_activity.activity_ts`. That column is wrong for the job: it also moves on
> `tool.used`, so a busy running session would read as permanently unread. This task adds
> a dedicated `attention_ts`, written **only** by `input.required`, `turn.ended`, and
> `session.ended` — the three kinds the spec actually names.

- [ ] **Step 1: Write the failing test**

```ts
// packages/store/tests/unread.test.ts
import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/migrations.ts";
import { applyEventToProjection } from "../src/project.ts";
import { listSessions } from "../src/queries.ts";

function db0(): Database {
  const db = new Database(":memory:");
  runMigrations(db);
  applyEventToProjection(db, {
    event_id: "e0", ts: "2026-09-11T10:00:00.000Z", session_id: "s1", kind: "session.started",
    version: 1, host: "h",
    payload: { agent_kind: "claude", command: "claude", args: [], env_overrides: {}, cwd: "/tmp", host: "h" },
  } as any);
  return db;
}

function ev(db: Database, kind: string, ts: string, payload: any = {}) {
  applyEventToProjection(db, { event_id: `e-${ts}`, ts, session_id: "s1", kind, version: 1, host: "h", payload } as any);
}

test("a fresh session with no attention event is not unread", () => {
  const db = db0();
  expect(listSessions(db, {})[0]!.unread).toBe(false);
});

test("input.required makes a session unread", () => {
  const db = db0();
  ev(db, "input.required", "2026-09-11T10:01:00.000Z", { kind: "permission" });
  expect(listSessions(db, {})[0]!.unread).toBe(true);
});

test("a later session.seen clears it", () => {
  const db = db0();
  ev(db, "input.required", "2026-09-11T10:01:00.000Z", { kind: "permission" });
  ev(db, "session.seen", "2026-09-11T10:02:00.000Z", { source: "attach" });
  expect(listSessions(db, {})[0]!.unread).toBe(false);
});

test("a new attention event after being seen makes it unread again", () => {
  const db = db0();
  ev(db, "input.required", "2026-09-11T10:01:00.000Z", { kind: "permission" });
  ev(db, "session.seen", "2026-09-11T10:02:00.000Z", { source: "attach" });
  ev(db, "turn.ended", "2026-09-11T10:03:00.000Z", {});
  expect(listSessions(db, {})[0]!.unread).toBe(true);
});

test("tool.used does NOT make a session unread", () => {
  const db = db0();
  ev(db, "tool.used", "2026-09-11T10:01:00.000Z", { tool: "Bash", detail: "ls" });
  expect(listSessions(db, {})[0]!.unread).toBe(false);
});

test("an out-of-order seen event never moves the marker backwards", () => {
  const db = db0();
  ev(db, "session.seen", "2026-09-11T10:05:00.000Z", { source: "dismiss" });
  ev(db, "session.seen", "2026-09-11T10:01:00.000Z", { source: "attach" });
  ev(db, "turn.ended", "2026-09-11T10:03:00.000Z", {});
  expect(listSessions(db, {})[0]!.unread).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/store/tests/unread.test.ts`
Expected: FAIL — `unread` is `undefined`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/store/src/schema.ts — append
export const SCHEMA_V6 = `
CREATE TABLE IF NOT EXISTS session_seen (
  session_id TEXT PRIMARY KEY,
  seen_ts    TEXT NOT NULL
);
ALTER TABLE session_activity ADD COLUMN attention_ts TEXT;
`;
```

```ts
// packages/store/src/migrations.ts
import { SCHEMA_V1, SCHEMA_V2, SCHEMA_V3, SCHEMA_V4, SCHEMA_V5, SCHEMA_V6 } from "./schema.ts";
// ...append to MIGRATIONS:
  { version: 6, up: (db) => { db.exec(SCHEMA_V6); } },
```

```ts
// packages/store/src/project.ts — add near the activity projection

// Only these kinds mean "this session wants you". Deliberately excludes
// tool.used, which moves activity_ts on every tool call.
function bumpAttention(db: Database, ev: EventEnvelope): void {
  if (!activityWritable(db, ev.session_id)) return;
  db.query(`
    INSERT INTO session_activity (session_id, attention_ts) VALUES (?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      attention_ts = MAX(COALESCE(session_activity.attention_ts, ''), excluded.attention_ts)
  `).run(ev.session_id, ev.ts);
}

// MAX() keeps the marker monotonic: events can arrive out of order (queue drain,
// clock skew), and a stale seen must never un-see newer acknowledgement.
function applySessionSeen(db: Database, ev: EventEnvelope): void {
  db.query(`
    INSERT INTO session_seen (session_id, seen_ts) VALUES (?, ?)
    ON CONFLICT(session_id) DO UPDATE SET seen_ts = MAX(session_seen.seen_ts, excluded.seen_ts)
  `).run(ev.session_id, ev.ts);
}
```

In the `switch (ev.kind)` dispatch: add `case "session.seen": applySessionSeen(db, ev); return;`, and call `bumpAttention(db, ev)` from the existing `input.required`, `turn.ended`, and `session.ended` branches (alongside what they already do — do not replace it).

`session.ended` sets `status = "ended"`, and `activityWritable` rejects ended sessions. Call `bumpAttention` **before** the status update inside that branch, so a finished session still registers as unread.

```ts
// packages/store/src/queries.ts — in BOTH select sites (the single-session select
// near line 43 and the listSessions select near line 84), add the join and column:
//   LEFT JOIN session_seen sn ON sn.session_id = s.session_id
// and in the column list:
//   , (a.attention_ts IS NOT NULL
//      AND (sn.seen_ts IS NULL OR a.attention_ts > sn.seen_ts)) AS unread
```

Map the SQLite integer to a boolean wherever rows are hydrated in `queries.ts`:

```ts
    unread: r.unread === 1 || r.unread === true,
```

```ts
// packages/store/src/index.ts — inside rebuildProjections, with the other DELETEs
      this.db.exec(`DELETE FROM session_seen`);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/store && bun run typecheck`
Expected: PASS (the whole store suite, to catch projection regressions).

- [ ] **Step 5: Commit**

```bash
git add packages/store/src packages/store/tests/unread.test.ts
git commit -m "feat(store): schema v6, attention_ts and the session_seen projection"
```

---

## Task 8: `?unread=1` on the query API

**Files:**
- Modify: `packages/hub/src/server.ts`, `packages/store/src/queries.ts`
- Test: `packages/hub/tests/unread-filter.test.ts` (create)

**Interfaces:**
- Consumes: `unread` (Task 7).
- Produces: `ListSessionsOpts.unread?: boolean`; `GET /sessions?unread=1`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/hub/tests/unread-filter.test.ts
import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "@agmux/store/src/migrations.ts";
import { applyEventToProjection } from "@agmux/store/src/project.ts";
import { listSessions } from "@agmux/store/src/queries.ts";

function seed(): Database {
  const db = new Database(":memory:");
  runMigrations(db);
  for (const id of ["s1", "s2"]) {
    applyEventToProjection(db, {
      event_id: `e-${id}`, ts: "2026-09-11T10:00:00.000Z", session_id: id, kind: "session.started",
      version: 1, host: "h",
      payload: { agent_kind: "claude", command: "claude", args: [], env_overrides: {}, cwd: "/tmp", host: "h" },
    } as any);
  }
  applyEventToProjection(db, {
    event_id: "e-r", ts: "2026-09-11T10:01:00.000Z", session_id: "s2", kind: "input.required",
    version: 1, host: "h", payload: { kind: "permission" },
  } as any);
  return db;
}

test("unread:true returns only sessions wanting attention", () => {
  const rows = listSessions(seed(), { unread: true });
  expect(rows.map((r) => r.session_id)).toEqual(["s2"]);
});

test("omitting the filter returns everything", () => {
  expect(listSessions(seed(), {}).length).toBe(2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/hub/tests/unread-filter.test.ts`
Expected: FAIL — `unread` is not an accepted option, so both sessions come back.

- [ ] **Step 3: Write minimal implementation**

In `packages/store/src/queries.ts`, add `unread?: boolean` to `ListSessionsOpts`, and when it is `true` append to the WHERE clause the same expression used for the column:

```sql
AND a.attention_ts IS NOT NULL AND (sn.seen_ts IS NULL OR a.attention_ts > sn.seen_ts)
```

In `packages/hub/src/server.ts`, inside the `/sessions` handler alongside the existing `status` parsing:

```ts
        const unread = url.searchParams.get("unread") === "1" ? true : undefined;
```

and pass `unread` through to `store.listSessions({ ... })`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/hub && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/server.ts packages/store/src/queries.ts packages/hub/tests/unread-filter.test.ts
git commit -m "feat(hub): ?unread=1 filter on /sessions"
```

---

## Task 9: `agmux seen`, attach integration, dash keys

**Files:**
- Create: `packages/cli/src/seen.ts`
- Test: `packages/cli/tests/seen.test.ts`
- Modify: `packages/cli/src/index.ts`, `packages/cli/src/attach.ts`, `packages/tui/src/opentui/DashApp.tsx`

**Interfaces:**
- Consumes: `SessionSeenPayload` (Task 6).
- Produces: `postSeen(sessionId, source, deps): Promise<boolean>`, `seenCmd(opts, deps): Promise<number>`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/tests/seen.test.ts
import { test, expect } from "bun:test";
import { postSeen } from "../src/seen.ts";

test("posts a session.seen envelope to /ingest", async () => {
  let body: any = null;
  const ok = await postSeen("agx-1", "attach", {
    hubUrl: "http://h", host: "box",
    fetchImpl: (async (_u: any, init: any) => { body = JSON.parse(init.body); return new Response(null, { status: 202 }); }) as unknown as typeof fetch,
    now: () => "2026-09-11T10:00:00.000Z",
    newId: () => "evt-1",
  });
  expect(ok).toBe(true);
  expect(body[0].kind).toBe("session.seen");
  expect(body[0].session_id).toBe("agx-1");
  expect(body[0].payload).toEqual({ source: "attach" });
});

test("a hub failure returns false instead of throwing — attach must still proceed", async () => {
  const ok = await postSeen("agx-1", "attach", {
    hubUrl: "http://h", host: "box",
    fetchImpl: (async () => { throw new Error("refused"); }) as unknown as typeof fetch,
    now: () => "t", newId: () => "e",
  });
  expect(ok).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/cli/tests/seen.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/cli/src/seen.ts
export interface PostSeenDeps {
  hubUrl: string;
  host: string;
  fetchImpl: typeof fetch;
  now: () => string;
  newId: () => string;
}

// Never throws: marking a session seen is bookkeeping, and must never be the
// reason an attach fails.
export async function postSeen(
  sessionId: string,
  source: "attach" | "dismiss",
  deps: PostSeenDeps,
): Promise<boolean> {
  try {
    const res = await deps.fetchImpl(`${deps.hubUrl}/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([{
        event_id: deps.newId(), ts: deps.now(), session_id: sessionId,
        kind: "session.seen", version: 1, host: deps.host, payload: { source },
      }]),
    });
    return res.status >= 200 && res.status < 300;
  } catch {
    return false;
  }
}

export async function seenCmd(
  opts: { idOrPrefix: string; hubUrl: string; host: string },
  deps: Omit<PostSeenDeps, "hubUrl" | "host">,
): Promise<number> {
  const ok = await postSeen(opts.idOrPrefix, "dismiss", { ...deps, hubUrl: opts.hubUrl, host: opts.host });
  return ok ? 0 : 1;
}
```

In `packages/cli/src/attach.ts`, after the session row is resolved and **before** the tmux commands are executed, fire and forget:

```ts
  void postSeen(row.session_id, "attach", {
    hubUrl: opts.hubUrl, host: row.host, fetchImpl: fetch,
    now: () => new Date().toISOString(), newId: () => crypto.randomUUID(),
  });
```

In `packages/tui/src/opentui/DashApp.tsx`, next to the existing `key.name === "y"` handler, add a `u` binding that toggles the highlighted row: call the injected action with `"dismiss"`. Follow the existing `props.actions` pattern — add `markSeen(sessionId: string): Promise<void>` to the actions interface in `packages/tui/src/types.ts` and implement it in `packages/cli/src/dash-actions.ts` by calling `postSeen`.

Wire `seen` into `packages/cli/src/index.ts` dispatch.

Finally add the tmux prefix binding from spec §8, in `agmux.tmux` inside `main` (the option table already documents `@agmux-mark-read-key`, default `u`). It marks the session owning the **current pane** read, which is the pane the user is looking at right now:

```bash
  mark_key="$(tmux_get "@agmux-mark-read-key" "u")"
  tmux bind-key "$mark_key" run-shell "$bin seen --pane '#{pane_id}'"
```

Support `--pane <id>` in `seenCmd` by resolving the pane to a session id: query `GET /sessions?status=open` and match on `tmux_pane`. When no session owns that pane, exit 0 silently — pressing the key in an unrelated pane is not an error.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test && bun run typecheck`
Expected: PASS (full suite — this task touches dash).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/seen.ts packages/cli/tests/seen.test.ts packages/cli/src/index.ts \
        packages/cli/src/attach.ts packages/cli/src/dash-actions.ts \
        packages/tui/src/opentui/DashApp.tsx packages/tui/src/types.ts
git commit -m "feat(cli): agmux seen, attach marks read, dash dismiss key"
```

---

## Task 10: Transition detection with debounce

**Files:**
- Create: `packages/tui/src/shared/transitions.ts`
- Test: `packages/tui/tests/shared/transitions.test.ts`

**Interfaces:**
- Consumes: `SessionRow`, `NotifyTrigger` (mirrored locally to keep `@agmux/tui` free of a `@agmux/cli` import).
- Produces: `createDetectState()`, `detectNotifications(state, rows, cfg, now): NotifyEvent[]`, types `DetectState`, `NotifyEvent`, `DetectConfig`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/tui/tests/shared/transitions.test.ts
import { test, expect } from "bun:test";
import { createDetectState, detectNotifications, type DetectConfig } from "../../src/shared/transitions.ts";
import { mkRow } from "../helpers/mk-row.ts";

const CFG: DetectConfig = { delayMs: 5000, triggers: ["permission", "prompt", "turn_end", "session_end"] };
const waiting = (over = {}) => mkRow({ session_id: "s1", status: "waiting", last_input_kind: "permission", activity_ts: "t1", ...over });

test("does not fire before the debounce elapses", () => {
  const st = createDetectState();
  expect(detectNotifications(st, [waiting()], CFG, 1000)).toEqual([]);
  expect(detectNotifications(st, [waiting()], CFG, 4000)).toEqual([]);
});

test("fires once the session has waited longer than the delay", () => {
  const st = createDetectState();
  detectNotifications(st, [waiting()], CFG, 1000);
  const out = detectNotifications(st, [waiting()], CFG, 7000);
  expect(out.length).toBe(1);
  expect(out[0]!.trigger).toBe("permission");
});

test("does not fire twice for the same wait", () => {
  const st = createDetectState();
  detectNotifications(st, [waiting()], CFG, 1000);
  detectNotifications(st, [waiting()], CFG, 7000);
  expect(detectNotifications(st, [waiting()], CFG, 9000)).toEqual([]);
});

test("a new attention event re-arms the notification", () => {
  const st = createDetectState();
  detectNotifications(st, [waiting()], CFG, 1000);
  detectNotifications(st, [waiting()], CFG, 7000);
  detectNotifications(st, [waiting({ activity_ts: "t2" })], CFG, 8000);
  expect(detectNotifications(st, [waiting({ activity_ts: "t2" })], CFG, 20000).length).toBe(1);
});

test("leaving waiting cancels a pending notification", () => {
  const st = createDetectState();
  detectNotifications(st, [waiting()], CFG, 1000);
  detectNotifications(st, [mkRow({ session_id: "s1", status: "running" })], CFG, 2000);
  expect(detectNotifications(st, [mkRow({ session_id: "s1", status: "running" })], CFG, 9000)).toEqual([]);
});

test("a trigger not in the config never fires", () => {
  const st = createDetectState();
  const cfg: DetectConfig = { delayMs: 0, triggers: ["turn_end"] };
  detectNotifications(st, [waiting()], cfg, 1000);
  expect(detectNotifications(st, [waiting()], cfg, 9000)).toEqual([]);
});

test("session end fires immediately regardless of delay", () => {
  const st = createDetectState();
  const ended = mkRow({ session_id: "s1", status: "ended", exit_code: 0, activity_ts: "t9" });
  expect(detectNotifications(st, [ended], CFG, 1000).map((e) => e.trigger)).toEqual(["session_end"]);
});

test("delayMs=0 fires on the first observation", () => {
  const st = createDetectState();
  expect(detectNotifications(st, [waiting()], { ...CFG, delayMs: 0 }, 1000).length).toBe(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/tui/tests/shared/transitions.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/tui/src/shared/transitions.ts
import type { SessionRow } from "@agmux/protocol";

export type NotifyTrigger = "permission" | "prompt" | "turn_end" | "session_end";

export interface DetectConfig {
  delayMs: number;
  triggers: NotifyTrigger[];
}

export interface NotifyEvent {
  session_id: string;
  trigger: NotifyTrigger;
  row: SessionRow;
}

export interface DetectState {
  /** session_id → { key, since } for a wait that has not yet fired. */
  pending: Map<string, { key: string; since: number; trigger: NotifyTrigger }>;
  /** Dedup keys already fired during this daemon run. */
  fired: Set<string>;
}

export function createDetectState(): DetectState {
  return { pending: new Map(), fired: new Set() };
}

// A session's "attention identity": the same wait keeps one key, so a repeated
// poll cannot re-fire, while a genuinely new event (new activity_ts) re-arms.
function dedupKey(r: SessionRow, trigger: NotifyTrigger): string {
  return `${r.session_id}:${trigger}:${r.activity_ts ?? ""}`;
}

function triggerFor(r: SessionRow): NotifyTrigger | null {
  if (r.status === "ended" || r.status === "lost") return "session_end";
  if (r.status === "waiting") {
    const k = r.last_input_kind;
    if (k === "permission" || k === "confirm") return "permission";
    return "prompt";
  }
  if (r.status === "idle") return "turn_end";
  return null;
}

export function detectNotifications(
  state: DetectState,
  rows: SessionRow[],
  cfg: DetectConfig,
  now: number,
): NotifyEvent[] {
  const out: NotifyEvent[] = [];
  const seenThisTick = new Set<string>();

  for (const row of rows) {
    const trigger = triggerFor(row);
    if (!trigger) continue;
    seenThisTick.add(row.session_id);
    if (!cfg.triggers.includes(trigger)) continue;

    const key = dedupKey(row, trigger);
    if (state.fired.has(key)) continue;

    // A terminal session is not "waiting" for anything — debouncing it would only
    // delay news that is already final.
    const immediate = trigger === "session_end" || cfg.delayMs === 0;

    const prev = state.pending.get(row.session_id);
    if (!prev || prev.key !== key) {
      state.pending.set(row.session_id, { key, since: now, trigger });
      if (!immediate) continue;
    }

    const since = immediate ? now : state.pending.get(row.session_id)!.since;
    if (immediate || now - since >= cfg.delayMs) {
      state.fired.add(key);
      state.pending.delete(row.session_id);
      out.push({ session_id: row.session_id, trigger, row });
    }
  }

  // A session that stopped wanting attention drops its pending timer, so a later
  // wait starts its debounce fresh rather than inheriting an old clock.
  for (const id of [...state.pending.keys()]) {
    if (!seenThisTick.has(id)) state.pending.delete(id);
  }
  return out;
}
```

Export from `packages/tui/src/index.ts`:

```ts
export { createDetectState, detectNotifications, type DetectState, type DetectConfig, type NotifyEvent, type NotifyTrigger } from "./shared/transitions.ts";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/tui/tests/shared/transitions.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/tui/src/shared/transitions.ts packages/tui/tests/shared/transitions.test.ts packages/tui/src/index.ts
git commit -m "feat(tui): debounced notification transition detection"
```

---

## Task 11: Notifier resolution and argv construction

**Files:**
- Create: `packages/cli/src/notifier.ts`
- Test: `packages/cli/tests/notifier.test.ts`

**Interfaces:**
- Consumes: `NotifyConfig` (Task 2), `NotifyEvent` (Task 10).
- Produces: `resolveNotifier(configured, which): NotifierKind | null`, `buildNotifyArgv(kind, spec, custom?)`, `notifyBody(ev)`, types `NotifierKind`, `NotifySpec`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/tests/notifier.test.ts
import { test, expect } from "bun:test";
import { resolveNotifier, buildNotifyArgv, type NotifySpec } from "../src/notifier.ts";

const SPEC: NotifySpec = { title: "agmux", body: "work:2 needs permission", sound: "Ping", attachId: "agx-1" };

test("auto prefers terminal-notifier when present", () => {
  expect(resolveNotifier("auto", (b) => b === "terminal-notifier")).toBe("terminal-notifier");
});

test("auto falls back to osascript on macOS when terminal-notifier is absent", () => {
  expect(resolveNotifier("auto", (b) => b === "osascript")).toBe("osascript");
});

test("auto falls back to notify-send when only that exists", () => {
  expect(resolveNotifier("auto", (b) => b === "notify-send")).toBe("notify-send");
});

test("auto yields null when nothing is available", () => {
  expect(resolveNotifier("auto", () => false)).toBe(null);
});

test("an explicit choice is honoured even if other binaries exist", () => {
  expect(resolveNotifier("osascript", () => true)).toBe("osascript");
});

test("an explicit choice that is not installed yields null rather than silently substituting", () => {
  expect(resolveNotifier("terminal-notifier", () => false)).toBe(null);
});

test("a custom command string is passed through", () => {
  expect(resolveNotifier("/usr/local/bin/my-notify", () => false)).toBe("custom");
});

test("terminal-notifier argv carries sound and a click-to-attach execute action", () => {
  const { cmd, args } = buildNotifyArgv("terminal-notifier", SPEC);
  expect(cmd).toBe("terminal-notifier");
  expect(args).toContain("-sound");
  expect(args).toContain("Ping");
  expect(args.join(" ")).toContain("agmux attach agx-1");
});

test("osascript argv embeds sound and escapes double quotes in the body", () => {
  const { cmd, args } = buildNotifyArgv("osascript", { ...SPEC, body: 'say "hi"' });
  expect(cmd).toBe("osascript");
  expect(args[0]).toBe("-e");
  expect(args[1]).toContain('sound name "Ping"');
  expect(args[1]).toContain('say \\"hi\\"');
});

test("a null sound omits the sound clause entirely", () => {
  const { args } = buildNotifyArgv("osascript", { ...SPEC, sound: null });
  expect(args[1]).not.toContain("sound name");
});

test("a custom command substitutes the documented variables", () => {
  const { cmd, args } = buildNotifyArgv("custom", SPEC, "/bin/n --title {title} --body {body} --id {session_id}");
  expect(cmd).toBe("/bin/n");
  expect(args).toEqual(["--title", "agmux", "--body", "work:2 needs permission", "--id", "agx-1"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/cli/tests/notifier.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/cli/src/notifier.ts
export type NotifierKind = "terminal-notifier" | "osascript" | "notify-send" | "custom";

export interface NotifySpec {
  title: string;
  body: string;
  sound: string | null;
  attachId: string | null;
}

export type Which = (bin: string) => boolean;

const AUTO_ORDER: NotifierKind[] = ["terminal-notifier", "osascript", "notify-send"];

// An explicitly configured notifier that is missing resolves to null rather than
// silently substituting another: a user who asked for one path should be told it
// is absent, not quietly given different behaviour.
export function resolveNotifier(configured: string, which: Which): NotifierKind | null {
  if (configured === "auto") return AUTO_ORDER.find((b) => which(b)) ?? null;
  if ((AUTO_ORDER as string[]).includes(configured)) {
    return which(configured) ? (configured as NotifierKind) : null;
  }
  return "custom";
}

function osaEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function buildNotifyArgv(
  kind: NotifierKind,
  spec: NotifySpec,
  custom?: string,
): { cmd: string; args: string[] } {
  switch (kind) {
    case "terminal-notifier": {
      const args = ["-title", spec.title, "-message", spec.body];
      if (spec.sound) args.push("-sound", spec.sound);
      if (spec.attachId) args.push("-execute", `agmux attach ${spec.attachId}`);
      return { cmd: "terminal-notifier", args };
    }
    case "osascript": {
      const sound = spec.sound ? ` sound name "${osaEscape(spec.sound)}"` : "";
      return {
        cmd: "osascript",
        args: ["-e", `display notification "${osaEscape(spec.body)}" with title "${osaEscape(spec.title)}"${sound}`],
      };
    }
    case "notify-send":
      return { cmd: "notify-send", args: [spec.title, spec.body] };
    case "custom": {
      const parts = (custom ?? "").split(/\s+/).filter((s) => s.length > 0).map((tok) =>
        tok
          .replace("{title}", spec.title)
          .replace("{body}", spec.body)
          .replace("{session_id}", spec.attachId ?? "")
          .replace("{sound}", spec.sound ?? ""),
      );
      return { cmd: parts[0] ?? "", args: parts.slice(1) };
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/cli/tests/notifier.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/notifier.ts packages/cli/tests/notifier.test.ts
git commit -m "feat(cli): runtime notifier resolution and argv construction"
```

---

## Task 12: Sinks — focus suppression, tmux toast, OS notification

**Files:**
- Create: `packages/cli/src/sinks.ts`
- Test: `packages/cli/tests/sinks.test.ts`
- Modify: `packages/cli/src/notifyd.ts`

**Interfaces:**
- Consumes: `NotifyEvent` (Task 10), `buildNotifyArgv`/`resolveNotifier` (Task 11), `NotifyConfig` (Task 2).
- Produces: `isPaneVisible(paneId, deps): Promise<boolean>`, `dispatchNotification(ev, cfg, deps): Promise<void>`, `SinkDeps`, `RunCmd`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/tests/sinks.test.ts
import { test, expect } from "bun:test";
import { dispatchNotification, isPaneVisible, type SinkDeps } from "../src/sinks.ts";
import { loadAttentionConfig } from "../src/attention-config.ts";
import { mkRow } from "../../tui/tests/helpers/mk-row.ts";

const CFG = loadAttentionConfig("").notify;

function deps(over: Partial<SinkDeps> = {}): SinkDeps & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    run: async (cmd, args) => { calls.push([cmd, ...args]); return 0; },
    capture: async () => "",
    which: () => true,
    log: () => {},
    ...over,
  } as SinkDeps & { calls: string[][] };
}

const ev = { session_id: "agx-1", trigger: "permission" as const, row: mkRow({ session_id: "agx-1", tmux_session: "work", tmux_window: "2", tmux_pane: "%3" }) };

test("fires both the tmux toast and the OS notifier", async () => {
  const d = deps();
  await dispatchNotification(ev, CFG, d);
  const cmds = d.calls.map((c) => c[0]);
  expect(cmds).toContain("tmux");
  expect(cmds).toContain("terminal-notifier");
});

test("uses display-message, never display-popup", async () => {
  const d = deps();
  await dispatchNotification(ev, CFG, d);
  const tmuxCall = d.calls.find((c) => c[0] === "tmux")!;
  expect(tmuxCall).toContain("display-message");
  expect(tmuxCall.join(" ")).not.toContain("popup");
});

test("a visible pane suppresses the tmux toast but NOT the OS notification", async () => {
  const d = deps({ capture: async () => "%3\n" });
  await dispatchNotification(ev, CFG, d);
  const cmds = d.calls.map((c) => c[0]);
  expect(cmds).not.toContain("tmux");
  expect(cmds).toContain("terminal-notifier");
});

test("sound disabled omits the sound argument", async () => {
  const d = deps();
  await dispatchNotification(ev, { ...CFG, sound: false }, d);
  const call = d.calls.find((c) => c[0] === "terminal-notifier")!;
  expect(call).not.toContain("-sound");
});

test("a per-trigger sound override wins over the global sound name", async () => {
  const d = deps();
  await dispatchNotification(ev, { ...CFG, sounds: { permission: "Sosumi" } }, d);
  const call = d.calls.find((c) => c[0] === "terminal-notifier")!;
  expect(call).toContain("Sosumi");
});

test("no notifier available logs once and does not throw", async () => {
  const d = deps({ which: () => false });
  await dispatchNotification(ev, CFG, d);
  expect(d.calls.map((c) => c[0])).not.toContain("terminal-notifier");
});

test("isPaneVisible compares the active pane of every attached client", async () => {
  expect(await isPaneVisible("%3", { capture: async () => "%1\n%3\n" } as any)).toBe(true);
  expect(await isPaneVisible("%9", { capture: async () => "%1\n%3\n" } as any)).toBe(false);
  expect(await isPaneVisible(null, { capture: async () => "%1\n" } as any)).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/cli/tests/sinks.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/cli/src/sinks.ts
import type { NotifyEvent } from "@agmux/tui";
import type { NotifyConfig } from "./attention-config.ts";
import { resolveNotifier, buildNotifyArgv, type NotifySpec } from "./notifier.ts";

export type RunCmd = (cmd: string, args: string[]) => Promise<number>;

export interface SinkDeps {
  run: RunCmd;
  capture: (cmd: string, args: string[]) => Promise<string>;
  which: (bin: string) => boolean;
  log: (s: string) => void;
}

// tmux knows which pane each attached client has active. It does NOT know whether
// the terminal emulator itself has OS focus — a pane can be "active" behind a
// browser window. So this gates the tmux toast only; the OS notification is
// precisely the signal that should still fire when you have tabbed away.
export async function isPaneVisible(
  paneId: string | null,
  deps: Pick<SinkDeps, "capture">,
): Promise<boolean> {
  if (!paneId) return false;
  try {
    const out = await deps.capture("tmux", ["list-clients", "-F", "#{pane_id}"]);
    return out.split("\n").map((s) => s.trim()).filter(Boolean).includes(paneId);
  } catch {
    return false;
  }
}

function describe(ev: NotifyEvent): string {
  const r = ev.row;
  const where = r.tmux_session ? `${r.tmux_session}:${r.tmux_window ?? ""}`.replace(/:$/, "") : r.agent_kind;
  const what =
    ev.trigger === "permission" ? "needs permission" :
    ev.trigger === "prompt" ? "is waiting for input" :
    ev.trigger === "turn_end" ? "finished a turn" : "ended";
  return `${where} ${what}`;
}

export async function dispatchNotification(
  ev: NotifyEvent,
  cfg: NotifyConfig,
  deps: SinkDeps,
): Promise<void> {
  const body = describe(ev);

  if (cfg.tmuxMessage && !(cfg.suppressWhenVisible && await isPaneVisible(ev.row.tmux_pane, deps))) {
    // display-message only. A popup freezes pane rendering and discards
    // keystrokes typed while it is open — see the spike in the spec, §2.
    try { await deps.run("tmux", ["display-message", `agmux: ${body}`]); } catch { /* tmux absent */ }
  }

  const kind = resolveNotifier(cfg.command, deps.which);
  if (!kind) { deps.log(`agmux: no notifier available (configured: ${cfg.command})`); return; }

  const sound = cfg.sound ? (cfg.sounds[ev.trigger] ?? cfg.soundName) : null;
  const spec: NotifySpec = { title: "agmux", body, sound, attachId: ev.session_id };
  const { cmd, args } = buildNotifyArgv(kind, spec, cfg.command);
  try {
    // Exit code is deliberately ignored: osascript returns 0 whether or not a
    // banner was shown, so it is not evidence of delivery (spec §2).
    await deps.run(cmd, args);
  } catch {
    deps.log(`agmux: notifier ${cmd} failed`);
  }
}
```

Wire into `packages/cli/src/notifyd.ts`: build a `DetectState` via `createDetectState()`, and in the `onRows` path call `detectNotifications(state, rows, { delayMs, triggers }, Date.now())`, dispatching each result through `dispatchNotification`. Skip entirely when `config.notify.enabled` is false.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/cli && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/sinks.ts packages/cli/tests/sinks.test.ts packages/cli/src/notifyd.ts
git commit -m "feat(cli): tmux toast and OS notification sinks with focus suppression"
```

---

## Task 13: Docs, usage, version bump

**Files:**
- Modify: `README.md`, `CHANGELOG.md`, `packages/protocol/src/version.ts`, `packages/cli/src/usage.ts`, `docs/agmux-foundation.md`

**Interfaces:**
- Consumes: everything above. Produces no new code interfaces.

- [ ] **Step 1: Add the commands to `agmux --help`**

In `packages/cli/src/usage.ts`, add to the command list, matching the existing wording style:

```
  statusline            render the tmux status line once and exit
  notifyd               watch sessions; render the status line and notify
  seen <id>             mark a session read (clears its unread flag)
```

- [ ] **Step 2: Document configuration in `README.md`**

Add a `### Attention signals` subsection under the existing configuration material containing the full `[notify]` and `[statusline]` TOML block from the spec (§7), the `agmux.tmux` options table (§8), and this note verbatim:

```markdown
Multi-line status needs tmux ≥ 3.3. On 3.2 the status line falls back to
`status-right` automatically — the documented tmux floor stays at 3.2.

`agmux notifyd` must be running for the status line to update; `status-format`
only reads a cache file the daemon writes.
```

- [ ] **Step 3: Record the event kind in the foundation doc**

In `docs/agmux-foundation.md` §6, add `session.seen` to the event-kind list with the one-line description: *"user acknowledged a session; projected into `session_seen`, drives the unread flag."*

- [ ] **Step 4: Bump the version and add a changelog entry**

Bump the patch/prerelease field in `packages/protocol/src/version.ts`, and add a `CHANGELOG.md` entry under a new heading:

```markdown
### Added
- Always-visible tmux status line of live agent sessions (`agmux notifyd`,
  `agmux statusline`, `@agmux-statusline` plugin options). Falls back to
  `status-right` below tmux 3.3.
- Debounced, focus-aware notifications when a session needs input or finishes,
  via `terminal-notifier`, `osascript`, `notify-send`, or a custom command.
- Read/unread tracking: `session.seen` events, the `session_seen` projection,
  `agmux seen`, `?unread=1`, and a dash dismiss key.
```

- [ ] **Step 5: Verify the whole suite and commit**

Run: `bun test && bun run typecheck && bun run build`
Expected: PASS, and three binaries build.

```bash
git add README.md CHANGELOG.md packages/protocol/src/version.ts packages/cli/src/usage.ts docs/agmux-foundation.md
git commit -m "docs: attention signals configuration, commands and changelog"
```

---

## Manual QA (after Task 13)

These are the items the spec marks as verified by hand rather than in CI:

1. `agmux notifyd &`, then set `@agmux-statusline on` and reload the plugin — confirm the second status line appears and tracks sessions.
2. Confirm the `status-right` fallback by temporarily setting `@agmux-statusline-position status-right`.
3. Click a status-line entry — confirm it attaches to that session, and that clicking empty status space does nothing.
4. `brew install terminal-notifier`, restart `notifyd`, block a session, and confirm the banner appears with correct app identity and that clicking it attaches.
5. Block a session while looking at its pane (expect no tmux toast, but an OS notification), then while in another window (expect both).
