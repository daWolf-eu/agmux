# agmux tmux plugin (TPM) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a TPM-installable tmux plugin that binds `prefix + g` (configurable) to open `agmux dash` in a popup; quitting dash closes the popup, and attaching/resuming a session retargets the parent client and closes the popup.

**Architecture:** A root `agmux.tmux` TPM entry binds the key to `display-popup -E … "agmux dash --popup"`. A new `--popup` dash mode makes attach/resume retarget the parent client then exit (which auto-closes the `-E` popup). Exit-without-spawn is signalled by an empty-`argv` `Handoff` sentinel.

**Tech Stack:** Bun + TypeScript (monorepo, `bun test`), React/ink TUI (`@agmux/tui`), POSIX/bash for the tmux plugin.

---

## File Structure

**TS — modify:**
- `packages/cli/src/parse-dash.ts` + `DashOpts` — parse `--popup`.
- `packages/cli/src/dash-actions.ts` — popup-aware attach/resume + pure helpers (`deltaEnv`, `attachInPopup`, `resumeIntoNewWindow`).
- `packages/cli/src/dash.ts` — thread `popup` into `makeActionsImpl`.
- `packages/tui/src/run-manage.tsx` — `handoffArgv` guard (empty argv = exit, no spawn).
- `packages/tui/src/types.ts` — document the empty-`argv` `Handoff` sentinel.

**TS — create (tests):**
- `packages/cli/tests/dash-actions.test.ts`
- `packages/tui/tests/run-manage.test.ts`

**Shell — create:**
- `agmux.tmux` (repo root, executable) — TPM entry, binds the key.

**Docs — modify:**
- `README.md` — TPM install + options section.

---

## Task 1: `--popup` flag parsing

**Files:**
- Modify: `packages/cli/src/parse-dash.ts`
- Test: `packages/cli/tests/parse-dash.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `packages/cli/tests/parse-dash.test.ts`:

```ts
test("--popup sets popup true and is not treated as an ls flag", () => {
  const p = parseDashArgs(["--popup", "--agent", "claude"], {});
  expect(p.kind).toBe("ok");
  if (p.kind !== "ok") return;
  expect(p.opts.popup).toBe(true);
  expect(p.opts.agent).toBe("claude");
});

test("popup defaults to false", () => {
  const p = parseDashArgs([], {});
  expect(p.kind === "ok" && p.opts.popup).toBe(false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/cli/tests/parse-dash.test.ts`
Expected: FAIL — `p.opts.popup` is `undefined` (property does not exist).

- [ ] **Step 3: Add `popup` to `DashOpts` and parse `--popup`**

In `packages/cli/src/parse-dash.ts`, add to the `DashOpts` interface:

```ts
export interface DashOpts extends LsQueryOpts {
  intervalMs: number;
  preview: PreviewMode;
  popup: boolean;
}
```

Add a `popup` local and a branch in the arg loop. Declare alongside the other locals:

```ts
  let preview: PreviewMode | undefined;
  let popup = false;
```

Add this branch in the `for` loop, before the final `else { rest.push(a); }`:

```ts
    } else if (name === "--popup") {
      popup = true;
```

Add `popup` to the returned `opts` object:

```ts
    opts: {
      ...parsed.opts,
      intervalMs: Math.round((intervalSec ?? cfg.interval ?? 1) * 1000),
      preview: preview ?? cfg.preview ?? "events",
      popup,
    },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/cli/tests/parse-dash.test.ts`
Expected: PASS (all tests, including the two new ones).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/parse-dash.ts packages/cli/tests/parse-dash.test.ts
git commit -m "dash: parse --popup flag"
```

---

## Task 2: Handoff exit sentinel (`handoffArgv` guard)

**Files:**
- Modify: `packages/tui/src/types.ts`
- Modify: `packages/tui/src/run-manage.tsx`
- Test: `packages/tui/tests/run-manage.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `packages/tui/tests/run-manage.test.ts`:

```ts
import { test, expect } from "bun:test";
import { handoffArgv } from "../src/run-manage.tsx";

test("null handoff yields no spawn", () => {
  expect(handoffArgv(null)).toBeNull();
});

test("empty-argv handoff is the exit sentinel: no spawn", () => {
  expect(handoffArgv({ argv: [] })).toBeNull();
});

test("non-empty handoff yields its argv", () => {
  expect(handoffArgv({ argv: ["tmux", "switch-client"] })).toEqual(["tmux", "switch-client"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/tui/tests/run-manage.test.ts`
Expected: FAIL — `handoffArgv` is not exported.

- [ ] **Step 3: Add `handoffArgv` and use it in `runManage`**

In `packages/tui/src/run-manage.tsx`, add the exported helper above `runManage`:

```ts
// A Handoff with an empty argv is the "exit dash, spawn nothing" sentinel
// (used by popup-mode attach/resume after they retarget the parent client).
// Returns the argv to spawn, or null when nothing should run.
export function handoffArgv(pending: Handoff | null): string[] | null {
  return pending && pending.argv.length > 0 ? pending.argv : null;
}
```

Replace the tail of `runManage` (the `if (pending) { … }` block) with:

```ts
  const argv = handoffArgv(pending);
  if (argv) {
    const env = pending!.env ?? process.env;
    const child = Bun.spawn(argv, { stdio: ["inherit", "inherit", "inherit"], env });
    await child.exited;
    return child.exitCode ?? 0;
  }
  return 0;
```

In `packages/tui/src/types.ts`, update the `Handoff` doc comment:

```ts
// A terminal hand-off: a command the entry point runs AFTER ink unmounts and the
// alt-screen is restored (for not-in-tmux attach and for resume/relaunch).
// An empty `argv` is the exit sentinel: dash exits and spawns nothing (popup-mode
// attach/resume use this after they retarget the parent tmux client inline).
export interface Handoff {
  argv: string[];
  env?: Record<string, string>;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/tui/tests/run-manage.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/tui/src/run-manage.tsx packages/tui/src/types.ts packages/tui/tests/run-manage.test.ts
git commit -m "tui: empty-argv Handoff is exit-without-spawn sentinel"
```

---

## Task 3: `deltaEnv` helper

**Files:**
- Modify: `packages/cli/src/dash-actions.ts`
- Test: `packages/cli/tests/dash-actions.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `packages/cli/tests/dash-actions.test.ts`:

```ts
import { test, expect } from "bun:test";
import { deltaEnv } from "../src/dash-actions.ts";

test("deltaEnv returns only keys whose value differs from base", () => {
  const base = { PATH: "/bin", HOME: "/home/x" };
  const spec = { PATH: "/bin", HOME: "/home/x", AGMUX_SESSION_ID: "abc", AGMUX_HUB_URL: "http://h" };
  expect(deltaEnv(spec, base)).toEqual({ AGMUX_SESSION_ID: "abc", AGMUX_HUB_URL: "http://h" });
});

test("deltaEnv includes keys missing from base", () => {
  expect(deltaEnv({ A: "1" }, {})).toEqual({ A: "1" });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/cli/tests/dash-actions.test.ts`
Expected: FAIL — `deltaEnv` is not exported.

- [ ] **Step 3: Add `deltaEnv`**

In `packages/cli/src/dash-actions.ts`, add at module scope (after the imports):

```ts
// The env keys a relaunch adds on top of the inherited environment. A new tmux
// window already inherits the parent env, so we only inject these via `-e`.
export function deltaEnv(
  specEnv: Record<string, string>,
  baseEnv: Record<string, string | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(specEnv)) {
    if (baseEnv[k] !== v) out[k] = v;
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/cli/tests/dash-actions.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/dash-actions.ts packages/cli/tests/dash-actions.test.ts
git commit -m "dash: deltaEnv helper for new-window env injection"
```

---

## Task 4: `attachInPopup` helper + popup attach wiring

**Files:**
- Modify: `packages/cli/src/dash-actions.ts`
- Test: `packages/cli/tests/dash-actions.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/cli/tests/dash-actions.test.ts`:

```ts
import { attachInPopup } from "../src/dash-actions.ts";

test("attachInPopup issues switch-client (+ select-pane) then returns the exit sentinel", async () => {
  const calls: string[][] = [];
  const runTmux = async (args: string[]) => { calls.push(args); };
  const h = await attachInPopup(
    { tmux_session: "work", tmux_window: "@3", tmux_pane: "%5" },
    runTmux,
  );
  expect(calls).toEqual([
    ["switch-client", "-t", "work:@3"],
    ["select-pane", "-t", "%5"],
  ]);
  expect(h).toEqual({ argv: [] });
});

test("attachInPopup without a pane switches window only", async () => {
  const calls: string[][] = [];
  const runTmux = async (args: string[]) => { calls.push(args); };
  await attachInPopup({ tmux_session: "work", tmux_window: "@3", tmux_pane: null }, runTmux);
  expect(calls).toEqual([["switch-client", "-t", "work:@3"]]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/cli/tests/dash-actions.test.ts`
Expected: FAIL — `attachInPopup` is not exported.

- [ ] **Step 3: Add `attachInPopup` and wire popup attach**

In `packages/cli/src/dash-actions.ts`, ensure these imports exist (extend the existing line):

```ts
import { buildAttachCommands, type AttachCoords } from "./attach.ts";
```

Add `AttachCoords` to the existing export in `packages/cli/src/attach.ts` if not already exported — it is declared as `export interface AttachCoords` there, so no change needed.

Add the helper at module scope:

```ts
// Popup-mode attach: retarget the parent client inline, then exit dash (empty
// argv) so the `display-popup -E` closes and reveals the agent's window.
export async function attachInPopup(
  coords: AttachCoords,
  runTmux: (args: string[]) => Promise<void>,
): Promise<Handoff> {
  for (const args of buildAttachCommands(coords, true)) await runTmux(args);
  return { argv: [] };
}
```

Change the `makeActions` signature to accept `popup` and an injectable tmux runner, and rewrite the `attach` branch:

```ts
export interface ActionDeps {
  runTmux: (args: string[]) => Promise<void>;
}

const defaultActionDeps: ActionDeps = {
  runTmux: async (args) => { await $`tmux ${args}`.quiet(); },
};

export function makeActions(
  hubUrl: string,
  wrapBin: string,
  popup = false,
  deps: ActionDeps = defaultActionDeps,
): Actions {
  const inTmux = !!process.env.TMUX;
  return {
    async attach(row: SessionRow): Promise<Handoff | null> {
      if (!LIVE_STATUSES.includes(row.status) || !row.tmux_session || !row.tmux_window) return null;
      const coords: AttachCoords = {
        tmux_session: row.tmux_session, tmux_window: row.tmux_window, tmux_pane: row.tmux_pane,
      };
      if (popup) return attachInPopup(coords, deps.runTmux);
      const cmds = buildAttachCommands(coords, inTmux);
      if (inTmux) { for (const args of cmds) await deps.runTmux(args); return null; }
      return { argv: ["tmux", ...cmds[0]!] };
    },
```

(Leave the existing `kill` action unchanged. The `resume` action is rewritten in Task 5.)

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/cli/tests/dash-actions.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/dash-actions.ts packages/cli/tests/dash-actions.test.ts
git commit -m "dash: popup-mode attach retargets parent client then exits"
```

---

## Task 5: `resumeIntoNewWindow` helper + popup resume wiring

**Files:**
- Modify: `packages/cli/src/dash-actions.ts`
- Test: `packages/cli/tests/dash-actions.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/cli/tests/dash-actions.test.ts`:

```ts
import { resumeIntoNewWindow } from "../src/dash-actions.ts";

test("resumeIntoNewWindow opens a non-detached window with delta env and returns the exit sentinel", async () => {
  let seen: any = null;
  const fakeNewWindow = async (a: any) => { seen = a; return { session: a.sessionName, window: "@9", pane: "%9" }; };
  const spec = { wrapArgv: ["agmux-wrap", "claude"], env: { PATH: "/bin", AGMUX_SESSION_ID: "abc12345" } };
  const h = await resumeIntoNewWindow(spec, "work", "abc12345", { PATH: "/bin" }, fakeNewWindow);
  expect(seen.sessionName).toBe("work");
  expect(seen.windowName).toBe("agmux:abc12345");
  expect(seen.cmd).toEqual(["agmux-wrap", "claude"]);
  expect(seen.env).toEqual({ AGMUX_SESSION_ID: "abc12345" });
  expect(seen.detach).toBe(false);
  expect(h).toEqual({ argv: [] });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/cli/tests/dash-actions.test.ts`
Expected: FAIL — `resumeIntoNewWindow` is not exported.

- [ ] **Step 3: Add `resumeIntoNewWindow` and wire popup resume**

In `packages/cli/src/dash-actions.ts`, extend the imports:

```ts
import { buildRelaunchSpec, type RelaunchSpec } from "./relaunch.ts";
import { newWindow, readCurrentPane } from "./tmux-place.ts";
```

Add the helper at module scope:

```ts
// Popup-mode resume: relaunch the agent in a NEW tmux window (non-detached, so the
// parent client switches to it), inject only the env delta, then exit dash (empty
// argv) so the popup closes onto the freshly relaunched agent.
export async function resumeIntoNewWindow(
  spec: RelaunchSpec,
  sessionName: string,
  label: string,
  baseEnv: Record<string, string | undefined>,
  newWindowFn: typeof newWindow = newWindow,
): Promise<Handoff> {
  await newWindowFn({
    sessionName,
    windowName: `agmux:${label}`,
    cmd: spec.wrapArgv,
    env: deltaEnv(spec.env, baseEnv),
    detach: false,
  });
  return { argv: [] };
}
```

Rewrite the `resume` action inside `makeActions` (replacing the current `resume`):

```ts
    async resume(row: SessionRow): Promise<Handoff> {
      const r = await fetch(`${hubUrl}/sessions/${row.session_id}`);
      const { session, usage } = (await r.json()) as { session: SessionRow; usage: { turn_count: number } | null };
      const spec = buildRelaunchSpec(session, {
        hubUrl, wrapBin, registry: createDefaultRegistry(), baseEnv: process.env,
        turnCount: usage?.turn_count ?? 0,
      });
      if (!popup) return { argv: spec.wrapArgv, env: spec.env };
      const coords = await readCurrentPane();
      const sessionName = coords?.session ?? session.tmux_session ?? "agmux";
      return resumeIntoNewWindow(spec, sessionName, row.session_id.slice(0, 8), process.env);
    },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/cli/tests/dash-actions.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Typecheck the cli + tui packages**

Run: `bun run --filter @agmux/cli typecheck && bun run --filter @agmux/tui typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/dash-actions.ts packages/cli/tests/dash-actions.test.ts
git commit -m "dash: popup-mode resume relaunches into a new window"
```

---

## Task 6: Thread `popup` through `dashCmd`

**Files:**
- Modify: `packages/cli/src/dash.ts`
- Test: `packages/cli/tests/dash.test.ts`

- [ ] **Step 1: Write the failing test**

In `packages/cli/tests/dash.test.ts`, the shared `opts` lacks `popup`; add it, and add a test that `dashCmd` forwards `popup` to `makeActionsImpl`. Update the `opts` literal:

```ts
const opts: DashOpts & { hubUrl: string; wrapBin: string } = {
  limit: 50, sort: "started", asc: false, reverse: false, status: "open",
  intervalMs: 1000, preview: "events", popup: false, hubUrl: "http://h", wrapBin: "agmux-wrap",
};
```

Append this test:

```ts
test("forwards popup flag to makeActions", async () => {
  let seenPopup: boolean | undefined;
  const deps: DashCmdDeps = {
    isTTY: () => true,
    runManageImpl: async () => 0,
    makeSourceImpl: () => ({ async mirror() { return ""; }, async events() { return []; }, async usage() { return null; } }),
    makeActionsImpl: (_h, _w, popup) => { seenPopup = popup; return { async attach() { return null; }, async kill() {}, async resume() { return { argv: [] }; } }; },
    errOut: () => {},
  };
  expect(await dashCmd({ ...opts, popup: true }, deps)).toBe(0);
  expect(seenPopup).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/cli/tests/dash.test.ts`
Expected: FAIL — `makeActionsImpl` is called with 2 args (no `popup`); `seenPopup` is `undefined`. (TypeScript will also flag the 3-arg signature mismatch.)

- [ ] **Step 3: Update `DashCmdDeps` and forward `popup`**

In `packages/cli/src/dash.ts`, change the `makeActionsImpl` signature in `DashCmdDeps`:

```ts
  makeActionsImpl: (hubUrl: string, wrapBin: string, popup: boolean) => Actions;
```

And update the `runManageImpl` call to pass `opts.popup`:

```ts
    actions: deps.makeActionsImpl(opts.hubUrl, opts.wrapBin, opts.popup),
```

The two existing mocks in `dash.test.ts` use `makeActionsImpl: () => (...)` — ignoring args is valid, so they still compile.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/cli/tests/dash.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Full cli/tui test + typecheck**

Run: `bun test packages/cli packages/tui && bun run --filter @agmux/cli typecheck && bun run --filter @agmux/tui typecheck`
Expected: all pass, no type errors.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/dash.ts packages/cli/tests/dash.test.ts
git commit -m "dash: forward --popup through dashCmd to makeActions"
```

---

## Task 7: TPM plugin entry (`agmux.tmux`)

**Files:**
- Create: `agmux.tmux` (repo root)

- [ ] **Step 1: Write the plugin script**

Create `agmux.tmux`:

```bash
#!/usr/bin/env bash
# agmux tmux plugin (TPM entry).
# Binds a key (default prefix+g) to open `agmux dash` in a tmux popup.
# Options (set before `run '~/.tmux/plugins/tpm/tpm'`):
#   @agmux-key           key under the prefix table (default: g)
#   @agmux-bin           agmux binary (default: agmux; use an absolute path
#                        if agmux is not on tmux's PATH)
#   @agmux-popup-width   popup width  (default: 80%)
#   @agmux-popup-height  popup height (default: 80%)
#   @agmux-dash-args     extra args appended to `agmux dash --popup`
set -euo pipefail

tmux_get() {
  local val
  val="$(tmux show-option -gqv "$1")"
  if [ -z "$val" ]; then printf '%s' "$2"; else printf '%s' "$val"; fi
}

main() {
  local key bin width height extra
  key="$(tmux_get "@agmux-key" "g")"
  bin="$(tmux_get "@agmux-bin" "agmux")"
  width="$(tmux_get "@agmux-popup-width" "80%")"
  height="$(tmux_get "@agmux-popup-height" "80%")"
  extra="$(tmux_get "@agmux-dash-args" "")"

  # Non-blocking warning if the key is already bound under the prefix table.
  if tmux list-keys -T prefix 2>/dev/null | grep -qE -- "-T prefix[[:space:]]+${key}([[:space:]]|$)"; then
    tmux display-message "agmux: prefix+${key} was already bound; overriding (set @agmux-key to change)"
  fi

  tmux bind-key "$key" display-popup -E -w "$width" -h "$height" "$bin dash --popup $extra"
}

main
```

- [ ] **Step 2: Make it executable**

Run: `chmod +x agmux.tmux`

- [ ] **Step 3: Syntax-check the script**

Run: `bash -n agmux.tmux && echo OK`
Expected: `OK` (no syntax errors).

- [ ] **Step 4: Verify the bind is created (requires a running tmux server)**

Run:
```bash
tmux new-session -d -s agmux-plugin-test
./agmux.tmux
tmux list-keys -T prefix | grep -E -- "-T prefix[[:space:]]+g[[:space:]]" | grep display-popup && echo BOUND
tmux kill-session -t agmux-plugin-test
```
Expected: a line containing `display-popup … agmux dash --popup`, then `BOUND`.

- [ ] **Step 5: Commit**

```bash
git add agmux.tmux
git commit -m "tmux: TPM plugin entry binds prefix+g to dash popup"
```

---

## Task 8: README — TPM install & options

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add a tmux-plugin section**

In `README.md`, after the `dash` keys/config block (the paragraph ending "…while dash stays alive."), insert:

```markdown
## tmux plugin (TPM)

Requires tmux ≥ 3.2 (`display-popup`) and `agmux` on tmux's PATH (or set `@agmux-bin`).

```tmux
# ~/.tmux.conf
set -g @plugin 'daWolf-eu/agmux'
run '~/.tmux/plugins/tpm/tpm'
```

Then `prefix + I` to install. `prefix + g` opens a popup running `agmux dash`:

- `q` closes the popup.
- `⏎` on a live session switches the parent client to the agent's window and closes the popup.
- `r` on a closed session relaunches it into a new window, switches there, and closes the popup.

Options (set before the `run` line):

| Option                | Default | Meaning                                              |
| --------------------- | ------- | ---------------------------------------------------- |
| `@agmux-key`          | `g`     | key under the prefix table                           |
| `@agmux-bin`          | `agmux` | agmux binary (use an absolute path if not on PATH)   |
| `@agmux-popup-width`  | `80%`   | popup width                                          |
| `@agmux-popup-height` | `80%`   | popup height                                         |
| `@agmux-dash-args`    | (empty) | extra args appended to `agmux dash` (e.g. `--agent claude`) |
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: TPM plugin install + options"
```

---

## Task 9: Manual end-to-end verification

**Files:** none (verification only)

- [ ] **Step 1: Build the binaries**

Run: `bun run --filter @agmux/cli build`
Expected: `packages/cli/dist/agmux` produced; `agmux` resolvable on PATH (symlink per README quickstart).

- [ ] **Step 2: Load the plugin into the current tmux**

Run: `tmux source-file ~/.tmux.conf` (with the README config in place), or for a dev checkout: `./agmux.tmux`.

- [ ] **Step 3: Walk the manual checklist (from the spec §7)**

Inside tmux, with at least one live and one closed agmux session present:
1. `prefix + g` → popup opens with `agmux dash`.
2. `q` → popup closes, back to the original pane.
3. `prefix + g`, select a **live** session, `⏎` → popup closes and the parent client is now on the agent's window/pane.
4. `prefix + g`, select a **closed** session, `r` → popup closes and a new window with the relaunched agent is focused.
5. `set -g @agmux-key C-o` then reload → `prefix + C-o` opens the popup.

Expected: every step behaves as described. If step 3 or 4 leaves the popup covering the agent, `switch-client`/`new-window` from inside the popup did not retarget the parent — revisit the spec §8 risks before claiming completion.

- [ ] **Step 4: Final full test sweep**

Run: `bun test`
Expected: all packages green.

---

## Self-Review notes

- **Spec coverage:** install/TPM (T7,T8) · keybinding default+config (T7) · popup open (T7) · close-on-quit (automatic via `-E`, exercised T9) · attach retargets parent + closes (T2,T4) · resume into new window (T5) · `--popup` flag (T1) · error handling: `@agmux-bin` + tmux ≥3.2 (T8 docs), `$TMUX`-unset fallback (existing `inTmux` path in T4). All covered.
- **No placeholders:** every code step shows full code; commands have expected output.
- **Type consistency:** `popup: boolean` flows `parse-dash` → `DashOpts` → `dashCmd` → `makeActions(hubUrl, wrapBin, popup, deps)`; `Handoff{argv:[]}` sentinel consumed by `handoffArgv`; `deltaEnv`/`attachInPopup`/`resumeIntoNewWindow` signatures match their call sites.
