# Rex Multiplexer Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the agmux CLI and dash work inside Rex as they do inside tmux today, with sessions openable across both multiplexers.

**Architecture:** One location per session in the existing `tmux_*` columns, with a nullable `mux` discriminator. A pure `planOpen` matrix decides what opening a row does, and a set of Rex operations with the same signatures as `tmux-place.ts` lets existing placement code run unchanged. All Rex calls go through one helper that pins the server and disables autostart.

**Tech Stack:** TypeScript on Bun, `bun:sqlite`, `bun:test`, the `rex` CLI.

**Spec:** `docs/superpowers/specs/2026-11-02-rex-multiplexer-design.md`

## Global Constraints

- `TMUX` set → `tmux`. `REX_BLOCK` set and `TMUX` unset → `rex`. Neither → `null`. Only `detectMux` reads these to decide.
- A null `mux` means tmux. tmux payloads stay byte-identical: `mux` and `mux_label` are only ever written for Rex.
- Every Rex call that targets a row passes `--autostart=false`, `-S <endpoint>` and a timeout, before the command word.
- Full ids only. Values are separate argv elements, never joined into a shell string.
- A Rex row's existence check has three results: present, gone, unreachable. Only gone resumes.
- Passing a `block:`, `window:` or `session:` id to tmux is a bug.
- Inside Rex, nothing starts tmux except showing a session that is live in tmux. Outside Rex, behaviour is unchanged except opening a live Rex row.
- No polling path fetches full scrollback.
- Git: branch `feature/rex-multiplexer`. Per `~/.claude/AGENTS.md`, commits and PRs carry no AI attribution; this overrides the default attribution reminder.
- `bun run typecheck` and `bun test` stay green after every task.

## Review Focus

1. Resuming a closed Rex row from tmux or a plain terminal: `session.tmux_session` is a UUID, so the `here?.session ?? session.tmux_session` fallbacks must not hand it to tmux. Test in Task 8.
2. `rex` missing from `PATH` under notifyd or a plain terminal, or not installed: reads as unreachable, with no crash or hang, and the row isn't resumed. Tests in Tasks 3 and 8.
3. A tmux session name with spaces, `:` or `#` in the Rex tab: argv stays intact, and the label is a fixed-shape hash. Test in Task 9.
4. A prompt with newlines and over 16 KB injected into a Rex block: delivered as one paste via stdin or a file, never argv. Test in Task 7.
5. A Rex label that is null, or holds control characters or `#`: `rex:<last 8 of id>` when null; stripped and `#`-doubled on the tmux status line. Test in Task 12.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `packages/protocol/src/mux.ts` (new) | `MuxKind`, `detectMux`, `rowMux`, `REX_ENV_KEYS`, `muxLocationText` |
| `packages/wrapper/src/rex.ts` (new) | Binary lookup, the one exec helper, reading the current location |
| `packages/cli/src/rex-place.ts` (new) | Rex placements, focus, client choice, presence, labelled-block lookup |
| `packages/cli/src/rex-io.ts` (new) | Rex capture tail, title, paste, keys |
| `packages/cli/src/mux-ops.ts` (new) | `placementOps(env)`: tmux or Rex operations with one shape |
| `packages/cli/src/open-row.ts` (new) | Pure `planOpen` matrix and the `Presence` type |
| `packages/cli/tests/helpers/fake-rex.ts` (new) | Scripted `RexExec` for tests |

## Task 1: Settle the Rex unknowns

Findings decide details in later tasks, so this runs first. No product code. It needs a real Rex and is run by hand or by an agent inside Rex.

**Files:**
- Create: `docs/spikes/2026-11-02-rex/REPORT.md`
- Modify: `docs/superpowers/plans/2026-11-02-rex-multiplexer.md` (only if a finding changes a later task)

**Interfaces:**
- Produces: confirmed answers to R1, R2, R4, R5, R6, R7 and L4 for Tasks 3, 5, 7, 9 and 11.

- [ ] **Step 1: Create the branch**

Run: `git switch -c feature/rex-multiplexer`
Expected: on the new branch.

- [ ] **Step 2: R1: measure a tail read on long scrollback**

In a throwaway Rex session, fill about 5 MiB of scrollback (`seq 1 700000`). Time `rex block call format '{"format":"text","max_bytes":4096}'` and then `blob_read` at `total - 65536`, 10 times each. Record p95 and the argument names `blob_read` really takes. Pass: under 250 ms.

- [ ] **Step 3: R4, R5: endpoint and argv**

Run `rex -S "$REX_SERVER" --autostart=false ls --json`. Then `rex window new --json -- /bin/sh -c 'printf "<%s>\n" "$@"; sleep 30' x 'a b' ';' '{"k":"v w"}'` and capture the block. Record whether `;`, spaces and JSON survive. If they don't, retry with `--shell=none` and record the `PATH` it gets.

- [ ] **Step 4: R6, R7: float behaviour**

Add nothing to `init.lua`. Press the existing scratch float key and, inside it, run `rex block inspect "$REX_BLOCK" --json` and `rex session inspect "$REX_SESSION" --json`. Record whether `$REX_BLOCK` is the float, whether `owner` is set, and how to find the tiled layer's focused block. Run `rex focus <tiled block>` then `exit`, and record where focus lands.

- [ ] **Step 5: L4 and R2**

Check `env | grep TMUX` in a Rex block. Time 20 sequential `rex block call title` calls.

- [ ] **Step 6: Write the report and commit**

Write results as one short section per item. If a finding contradicts a later task, edit that task in this plan in the same commit.

The spec and plan are still uncommitted, so they go in here too.

```bash
git add docs/spikes/2026-11-02-rex/REPORT.md docs/superpowers/plans/2026-11-02-rex-multiplexer.md docs/superpowers/specs/2026-11-02-rex-multiplexer-design.md
git commit -m "docs(rex): add design, plan and Rex behaviour findings"
```

## Task 2: Protocol and store

**Files:**
- Create: `packages/protocol/src/mux.ts`, `packages/protocol/tests/mux.test.ts`
- Modify: `packages/protocol/src/index.ts`, `events.ts`, `session.ts`, `packages/store/src/schema.ts`, `migrations.ts`, `project.ts`, `queries.ts`
- Test: `packages/store/tests/mux-projection.test.ts`

**Interfaces:**
- Produces:
  - `type MuxKind = "tmux" | "rex"`
  - `detectMux(env: Record<string, string | undefined>): MuxKind | null`
  - `rowMux(row: { mux?: MuxKind | null }): MuxKind`, null → `"tmux"`
  - `REX_ENV_KEYS = ["REX_BLOCK", "REX_SESSION", "REX_SERVER"] as const`
  - `SessionRow.mux: MuxKind | null`, `SessionRow.mux_label: string | null`
  - Optional payload fields: `mux`, `mux_label` on started and registered; `new_mux`, `new_mux_label` on `session.resumed`

- [ ] **Step 1: Write failing tests**

```ts
test("detectMux", () => {
  expect(detectMux({ TMUX: "/s,1,0", REX_BLOCK: "block:x" })).toBe("tmux");
  expect(detectMux({ REX_BLOCK: "block:x" })).toBe("rex");
  expect(detectMux({})).toBeNull();
});
// mux-projection.test.ts
test("old tmux events replay with mux null");
test("started with mux rex stores mux and label");
test("resumed from rex into tmux with null socket clears socket, mux and label");
test("registered: rex row, tmux payload with coords and null socket replaces all location fields");
test("registered: tmux row, rex payload replaces tmux_server with null");
test("registered: same mux keeps COALESCE (null socket keeps old socket)");
test("registered: payload with no coords and no mux leaves a rex row untouched");
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test packages/protocol/tests/mux.test.ts packages/store/tests/mux-projection.test.ts`
Expected: FAIL, `detectMux` not defined.

- [ ] **Step 3: Implement**

Add `SCHEMA_V12` (`ALTER TABLE sessions ADD COLUMN mux TEXT; ADD COLUMN mux_label TEXT`) and migration version 12. `applyStarted` and `applyResumed` write both columns.

In `applyRegistered`, select `mux` with `status`. A payload is switching when it has coords (`tmux_session` or `tmux_pane` non-null) and `(p.mux ?? null) !== (existing.mux ?? null)`. Both update branches then assign the location fields and `mux`, `mux_label` directly instead of `COALESCE`. Don't change `launchParams`' bind order for the non-switching path.

`queries.ts`: `mux: remote ? null : raw.mux ?? null`, same for `mux_label`. Fix `SessionRow` fixtures that typecheck flags, with `mux: null, mux_label: null`.

- [ ] **Step 4: Run to verify they pass**

Run: `bun test packages/protocol packages/store && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages
git commit -m "feat(protocol): record which multiplexer a session is in"
```

## Task 3: The one Rex helper

**Files:**
- Create: `packages/wrapper/src/rex.ts`, `packages/wrapper/tests/rex.test.ts`, `packages/cli/tests/helpers/fake-rex.ts`
- Modify: `packages/wrapper/src/index.ts` (exports)

**Interfaces:**
- Consumes: `detectMux`, Task 1's `-S` finding.
- Produces, all exported from `@agmux/wrapper`:
  - `type RexExec = (args: string[], stdin?: Uint8Array) => Promise<{ code: number; stdout: string }>`
  - `resolveRexBin(env, exists?: (p: string) => boolean): string | null`
  - `rexTarget(server: string | null, timeout?: string): string[]`, default timeout `"2s"`
  - `defaultRexExec: RexExec`, returning code `127` when no binary resolves and `124` on timeout kill
  - `interface RexCoords { session: string; window: string | null; pane: string; socket: string | null; label: string | null }`
  - `readCurrentRexCoords(env, exec?: RexExec): Promise<RexCoords | null>`
  - `fakeRex(script: Record<string, { code?: number; stdout?: string }>): RexExec & { calls: string[][] }` in the test helper, matching on the args after the global flags

- [ ] **Step 1: Write failing tests**

```ts
test("rexTarget pins the server and disables autostart", () => {
  expect(rexTarget("unix:///a%20b/s.sock")).toEqual(["--autostart=false", "-S", "unix:///a%20b/s.sock", "--timeout", "2s"]);
  expect(rexTarget(null, "10s")).toEqual(["--autostart=false", "--timeout", "10s"]);
});
test("resolveRexBin order: PATH, then REX_BIN_DIR, then the macOS app path");
test("resolveRexBin returns null when none exist");
test("defaultRexExec with no binary returns code 127 and does not throw");
test("readCurrentRexCoords combines whoami with the session label");
test("readCurrentRexCoords falls back to env ids with window null when whoami fails");
test("readCurrentRexCoords returns null when REX_BLOCK or REX_SESSION is unset");
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test packages/wrapper/tests/rex.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement in `packages/wrapper/src/rex.ts`**

The macOS path is `~/Library/Application Support/com.superlogical.rex/RexServer/Versions/Current/Rex Server.app/Contents/MacOS/rex`. Coordinates come from `rex whoami --json` (`session_id`, `window_id`, `block_id`) with `socket` from `env.REX_SERVER`. The label comes from `.sessions[]` in `rex ls --json`. Compare whoami's ids to `REX_SESSION` and `REX_BLOCK`: if they differ, whoami has been told about a different location, so trust the env ids.

- [ ] **Step 4: Run to verify they pass**

Run: `bun test packages/wrapper/tests/rex.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages
git commit -m "feat(wrapper): add the Rex command helper"
```

## Task 4: Agents start and register in Rex

**Files:**
- Modify: `packages/wrapper/src/index.ts:53-86,105-116`, `lifecycle.ts`, `packages/cli/src/emit.ts:88-107,205`, `headless.ts:15-21`, `attach-place.ts:47,68-71`, `run.ts:244-250`
- Test: `packages/wrapper/tests/lifecycle.test.ts`, `packages/wrapper/tests/rex.test.ts`, `packages/cli/tests/emit.test.ts`, `headless.test.ts`, `attach-place.test.ts`

**Interfaces:**
- Consumes: `readCurrentRexCoords`, `detectMux`, `REX_ENV_KEYS`.
- Produces:
  - `readCurrentCoords(env): Promise<(TmuxCoords & { mux?: "rex"; label?: string | null }) | null>` in `packages/wrapper/src/index.ts`, used in place of `readCurrentTmuxCoords` at line 54
  - `buildStartedEvent` and `buildResumedEvent` accept `mux` and `mux_label`
  - `enrichMuxCoords(events, env, resolveTmux, rexExec?)`, renaming `enrichTmuxCoords`

- [ ] **Step 1: Write failing tests**

```ts
test("buildStartedEvent and buildResumedEvent carry mux and label only when given");
test("readCurrentCoords in Rex returns mux rex and never calls tmux");
test("readCurrentCoords in Rex with a failing whoami returns env ids, never null into the tmux path");
test("enrichMuxCoords fills rex ids, socket and label on session.registered", async () => {
  // env { REX_BLOCK, REX_SESSION, REX_SERVER }, tmux_pane null in the payload
  // expect payload.mux "rex", tmux_pane = block id, tmux_server undefined
});
test("enrichMuxCoords with TMUX and REX_BLOCK set takes the tmux path");
test("enrichMuxCoords leaves coords null and does not throw when rex fails");
test("scrubTmuxEnv removes REX_BLOCK, REX_SESSION, REX_SERVER");
test("withoutTmuxEnv removes REX_BLOCK, REX_SESSION, REX_SERVER");
test("attachCtxFor sets inMux for tmux and for rex");
test("direct launch in Rex runs inherit, not new-session");
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test packages/cli/tests/emit.test.ts packages/cli/tests/headless.test.ts packages/cli/tests/attach-place.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

The wrapper branches on `detectMux(process.env)` before any tmux check. If `detectMux` says `rex` but `readCurrentRexCoords` returns null, still run inline with null coords: an agent in Rex must never start tmux.

Adapters' `normalize.ts` need no change: they copy `TMUX_PANE`, which is unset in Rex, so enrichment fills everything. This is a simplification of the spec's wording with the same result.

Rename `AttachCtx.inTmux` to `inMux` here (also `packages/tui/src/shared/attach-targets.ts`, `dash.ts:72`, `attach-remote.ts:101,107`, tests), computed as `detectMux(env) !== null`. Rename "not in tmux" reason text to "not in a multiplexer" and update the tests that pin it. `run.ts`'s inherit fallback tests `detectMux(process.env) === null` instead of `readCurrentPane()`.

`attachKind` in `attach-targets.ts`: a live row with `mux === "rex"` is `"live"` when `tmux_pane` is set, whether or not `tmux_window` is.

- [ ] **Step 4: Run to verify they pass**

Run: `bun test packages/cli packages/wrapper packages/tui && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages
git commit -m "feat(wrapper): run and register agents inside Rex"
```

## Task 5: Rex placements

**Files:**
- Create: `packages/cli/src/rex-place.ts`, `packages/cli/src/mux-ops.ts`, `packages/cli/tests/rex-place.test.ts`
- Modify: `packages/cli/src/run.ts:191-243`, `resume-place.ts:32-40`, `dash-actions.ts:54-59`

**Interfaces:**
- Consumes: `RexExec`, `rexTarget`, `holdOnFailure`, `PaneCoords`, Task 1's R5 and R7 findings.
- Produces, in `rex-place.ts`, each taking a trailing `exec: RexExec = defaultRexExec` and matching the `tmux-place.ts` signature:
  - `rexCurrentPane(env, popup: boolean, exec?): Promise<PaneCoords | null>`, anchoring on the tiled block in a popup
  - `rexSplitPane`, `rexNewWindow`, `rexNewSession`, `rexHasSession`, `rexSwitchClient`
  - `rexNewLabelledTab(a: { session: string; label: string; cmd: string[]; env: Record<string, string>; socket: string | null }, exec?): Promise<PaneCoords>` using `rex run --label`
  - `findLabelledBlock(session: string, label: string, socket: string | null, exec?): Promise<string | null>`
- Produces, in `mux-ops.ts`:
  - `interface PlacementOps extends ResumePlacementDeps { kind: MuxKind; currentPane: () => Promise<PaneCoords | null>; splitPane: typeof splitPane }`
  - `placementOps(env, popup?: boolean): PlacementOps`, Rex for `detectMux === "rex"`, otherwise today's tmux functions

- [ ] **Step 1: Write failing tests**

```ts
test("rexSplitPane: argv, env via env(1), hold wrapper, ids from --json", async () => {
  // expect rex --autostart=false -S S --timeout 10s split -s SESS -b BLOCK --json
  //   -- env K=V /bin/sh -c <hold> agmux-hold cmd
});
test("rexSplitPane detach adds --focus=false");
test("rexNewWindow honours cwd and uses the session id");
test("rexNewWindow with a label override resolves the label, or creates that session");
test("rexNewSession returns ids from .session_id and .initial_windows[0]");
test("rexSwitchClient parses 'session:<u>:window:<u>'");
test("rexCurrentPane in popup returns the tiled block, not REX_BLOCK");
test("rexCurrentPane in popup with no tiled block returns null");
test("placementOps picks rex only for detectMux rex");
test("runWithPlacement in Rex prints the block id and never calls tmux");
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test packages/cli/tests/rex-place.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

Rex's placement timeout is `"10s"`; probes use the default. In a popup, `REX_BLOCK` is the float and `session inspect` reports the float as the window's `focused_block_id` (Task 1, R6). Rex does not expose which block a tiled layer has focused while a float is in front: `session inspect`, `session.view`, `session.list_blocks` and the event stream carry only the window-level `focused_block_id` (the float) and no per-layer focus or marker (Task 1 fix round). So the popup anchor is the first block of the `kind: "tiled"` layer in the window whose `window_id` equals `.block.window_id` from `rex block inspect "$REX_BLOCK" --json`, and with split panes that can be the wrong pane. This is a deliberate degradation: `new-pane` and the highlight may land on the first tiled block, not the one the user was in. The exact fix is outside agmux (the popup binding in `init.lua` passing the focused block id), and is out of scope here. With one tiled block it is exact. `cwd` maps to `-c`. `rexHasSession` matches a full id or an exact label in `rex ls --json`. `rex focus` needs `-s <session>` outside the block's own session. `rex run --label L --json` does not echo the label: it returns `{window_id, block_ids:[id], revision}`, and the label is visible only in `rex block ls --json`. `rex run --wait --json` prints that result, then the child's exit status as the process exit code and `Error: exit status N` on stderr. A block whose program has exited is closed at once and disappears, so `rexPresence` on it is `gone`. `rexSwitchClient`'s target string keeps `ResumePlacementDeps`' signature so callers don't change. Parse it with `/^(session:[^:]+):(window:.+)$/` and run `rex focus -s <session> <window>` for now. Task 8 replaces this with `rexFocus`, which also switches the app.

`run.ts`'s `runWithPlacement` takes its operations from `placementOps(process.env)`. `pickWindowTargetSession` keeps its order, so `AGMUX_TMUX_SESSION` becomes a label in Rex. `new-pane` outside any multiplexer keeps today's message and exit 2.

- [ ] **Step 4: Run to verify they pass**

Run: `bun test packages/cli/tests/rex-place.test.ts packages/cli/tests/tmux-place.test.ts packages/cli/tests/run*.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages
git commit -m "feat(cli): place agents in Rex panes, tabs and sessions"
```

## Task 6: Rex I/O: preview

**Files:**
- Create: `packages/cli/src/rex-io.ts`, `packages/cli/tests/rex-io.test.ts`
- Modify: `packages/cli/src/dash-preview.ts:27-32`, `packages/tui/src/types.ts:27`
- Test: `packages/cli/tests/dash-preview.test.ts`

**Interfaces:**
- Consumes: `RexExec`, `rexTarget`, Task 1's R1 finding.
- Produces in `rex-io.ts`:
  - `rexTail(row: { tmux_session, tmux_pane, tmux_socket }, maxBytes?: number, exec?): Promise<string>`, default `65536`, `""` on any failure
  - `rexTitle(row, exec?): Promise<string | null>`
  - `class RexPoll { delayMs(blockId: string, baseMs: number): number; record(blockId: string, tookMs: number): void }`, returning at least `1000` for a block whose last read exceeded `250`

- [ ] **Step 1: Write failing tests**

```ts
test("rexTail under maxBytes returns content from one format call");
test("rexTail over maxBytes calls blob_read at total - maxBytes and returns only the tail");
test("rexTail loops blob_read until eof, because a reply can be shorter than max_bytes");
test("rexTail on any failure returns an empty string");
test("rexTail never calls rex capture");
test("RexPoll backs off to 1000 ms after a 300 ms read and recovers after a fast one");
test("mirror on a rex row calls rexTail, not tmux");
test("mirror on a tmux row is unchanged");
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test packages/cli/tests/rex-io.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`format` is called with `{"format":"text","max_bytes":<maxBytes>}`; its reply has `content`, `total`, and an `id` when more remains. Task 1 found that `content` is the HEAD of the scrollback, not the tail, so when `id` is set the tail comes only from `blob_read` with `{"id":<id>,"offset":total-maxBytes,"max_bytes":<maxBytes>}`. A `blob_read` reply (`id`, `data`, `total`, `eof`) is routinely shorter than `max_bytes` (about 56 KiB for 64 KiB asked, because the limit counts the JSON-encoded string) with `eof:false`, so keep reading at `offset += byteLength(data)` until `eof`. The offset can fall inside a multi-byte character, so drop a leading U+FFFD. Measured p95 on 4 MiB of scrollback was 50 ms for `format` and 32 ms for `blob_read`. `makePreviewSource` gains a third parameter `rexExec: RexExec = defaultRexExec`, and `mirror` branches on `rowMux(row)`. It skips the read when `RexPoll` says the block isn't due, returning the last text.

- [ ] **Step 4: Run to verify they pass**

Run: `bun test packages/cli/tests/rex-io.test.ts packages/cli/tests/dash-preview.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages
git commit -m "feat(cli): preview Rex sessions with a bounded tail read"
```

## Task 7: Prompt injection in Rex

**Files:**
- Modify: `packages/cli/src/tmux-inject.ts:156-280`, `rex-io.ts`, `run.ts:141-152`
- Test: `packages/cli/tests/tmux-inject.test.ts`, `packages/cli/tests/rex-io.test.ts`

**Interfaces:**
- Consumes: `rexTail`, `RexExec`.
- Produces:
  - `interface InjectPrimitives { capture(pane: string): Promise<string>; clearLine(pane: string): Promise<void>; paste(pane: string, bytes: Uint8Array): Promise<void>; submit(pane: string): Promise<void> }`
  - `InjectOpts.primitives?: InjectPrimitives`, `VerifiedSubmitOpts.submit` replacing `exec`
  - `rexPrimitives(row: { session: string; socket: string | null }, exec?): InjectPrimitives` in `rex-io.ts`
  - `runInjectStep` args gain `mux?: MuxKind` and `session?: string`

- [ ] **Step 1: Write failing tests**

```ts
test("rexPrimitives.clearLine sends ctrl+a then ctrl+k");
test("rexPrimitives.submit sends enter");
test("rexPrimitives.paste sends block.event paste through stdin, not argv", async () => {
  const text = "line1\nline2\n" + "x".repeat(20_000);
  // assert no argv element contains "line1", the stdin JSON parses to the same text,
  // and the call is `rex api call -s SESS block.event -`
});
test("injectBootstrap with rex primitives never calls tmux");
test("existing tmux inject tests pass unchanged apart from the submit seam");
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test packages/cli/tests/tmux-inject.test.ts packages/cli/tests/rex-io.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Move tmux's three actions into a `tmuxPrimitives(socket, exec, capture)` private function, so `injectBootstrap` calls only primitives and the 16 KB and bracketed-paste behaviour stays as it is. For Rex, the default `pollIntervalMs` is `500` (Task 1 measured a tail read at p95 50 ms, so 500 leaves a 10x margin), and it rises to at least `1000` when `RexPoll` reports the block as slow.

- [ ] **Step 4: Run to verify they pass**

Run: `bun test packages/cli/tests/tmux-inject.test.ts packages/cli/tests/rex-io.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages
git commit -m "feat(cli): inject bootstrap prompts into Rex blocks"
```

## Task 8: Opening a row: matrix, presence and focus

**Files:**
- Create: `packages/cli/src/open-row.ts`, `packages/cli/tests/open-row.test.ts`
- Modify: `packages/cli/src/rex-place.ts`, `attach.ts:60-140`, `dash-actions.ts:97-154`, `attach-placed.ts`, `packages/tui/src/types.ts`, `packages/tui/src/opentui/DashApp.tsx:205-215`
- Test: `packages/cli/tests/rex-place.test.ts`, `attach.test.ts`, `dash-actions.test.ts`

**Interfaces:**
- Consumes: `placementOps`, `RexExec`.
- Produces:
  - `type Presence = "present" | "gone" | "unreachable"` and
    `type OpenPlan = "tmux-native" | "tmux-tab" | "focus-rex" | "resume" | "unreachable"`
  - `planOpen(a: { caller: MuxKind | null; row: MuxKind; live: boolean; presence: Presence }): OpenPlan`
  - `rexPresence(row, exec?): Promise<Presence>`: code 0 present, 3 gone, anything else unreachable
  - `probeRow(row, tmuxExists): Promise<Presence>`
  - `pickClient(callerBlock: { block: string; server: string } | null, rowServer: string | null, exec?): Promise<string | null>`, taking the owner of `callerBlock.block`, or in a popup of the tiled block, since a float has no owner when no app is attached
  - `rexFocus(row: { session: string; window: string | null; pane: string; socket: string | null }, caller, exec?): Promise<"selected" | "focused-only" | "no-app">`
  - `Handoff.notice?: string`: when set, the dash shows it and stays open

- [ ] **Step 1: Write failing tests**

```ts
test.each([
  // caller, row, live, presence, plan
  ["rex",  "rex",  true,  "present",     "focus-rex"],
  ["rex",  "tmux", true,  "present",     "tmux-tab"],
  ["tmux", "tmux", true,  "present",     "tmux-native"],
  [null,   "tmux", true,  "present",     "tmux-native"],
  ["tmux", "rex",  true,  "present",     "focus-rex"],
  [null,   "rex",  true,  "present",     "focus-rex"],
  ["rex",  "rex",  true,  "gone",        "resume"],
  ["rex",  "tmux", true,  "gone",        "resume"],
  ["tmux", "rex",  true,  "gone",        "resume"],
  ["rex",  "rex",  true,  "unreachable", "unreachable"],
  [null,   "rex",  true,  "unreachable", "unreachable"],
  ["rex",  "rex",  false, "gone",        "resume"],
] as const)("planOpen %s %s %s %s", (caller, row, live, presence, plan) => {
  expect(planOpen({ caller, row, live, presence })).toBe(plan);
});
test("rexPresence: exit 3 gone, exit 4 unreachable, 127 unreachable, 124 unreachable");
test("rexFocus runs focus_block then session.select with the owner of REX_BLOCK, or in a popup the owner of the tiled block");
test("rexFocus for a row on another server uses the sole app there");
test("rexFocus with two apps and no owner focuses only and returns focused-only");
test("rexFocus with no app returns no-app and does not throw");
test("attach of an unreachable Rex row does not resume and reports it");
test("resume of a closed Rex row from tmux targets the caller's tmux session, never the row's UUID");
test("resume of a closed Rex row outside any mux does not pass the UUID to tmux");
test("resume of a closed tmux row inside Rex opens a new tab and never calls tmux");
test("focus from outside Rex returns a notice 'opened in Rex' and the dash stays open");
test("agmux attach outside Rex prints 'opened in Rex' and exits 0");
test("popup attach returns empty argv after focusing");
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test packages/cli/tests/open-row.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`planOpen` applies, in order: unreachable; `!live` or gone → resume; `row === "rex"` → focus-rex; `caller === "rex"` → tmux-tab; else tmux-native. `decideAttach` stays as it is for `resume-nearest.ts`, which only sees tmux.

`attachCmd`, `dash-actions.attach` and `dash-actions.resume` use `planOpen` and `placementOps`. tmux-native keeps today's code. Replace both `session.tmux_session` fallbacks (`attach.ts:641`, `dash-actions.ts:126`) so they apply only when `rowMux(session) === "tmux"`; otherwise use `AGMUX_TMUX_SESSION_DEFAULT` outside Rex. `rexSwitchClient` now calls `rexFocus`.

Task 1 findings that change this task. A float's block has no `owner` in a session no app is attached to (needs a manual check with an app attached, see the report), so in a popup take the owner from the tiled block, and verify it against the `clients` list in `session inspect`: a stale owner id is possible (a throwaway session's first block was owned by a CLI client that had already gone). When a popup float closes, Rex does NOT return focus to the block that was focused before; it focuses the most recently created tiled block. Focus set from inside the float sticks: Task 1 ran `rex focus <tiled block>` inside the float and focus stayed on that block after the float exited. So `rexFocus` runs `focus_block` on the target before the popup closes, while the dash is still running; it cannot run anything after the float closes because the dash is gone by then. Never rely on Rex restoring focus on its own.

Messages: `unreachable` throws `Rex server unreachable; not resuming <id8>`; `no-app` throws `Rex app not running`; `focused-only` returns the notice `opened in Rex; several Rex apps connected, could not switch`. Outside Rex, success returns `{ argv: [], notice: "opened in Rex" }`. Update `attachPlacedCmd` and `attachCmd` to print `notice`. In `DashApp.tsx`, `if (h?.notice) setNotice(h.notice); else if (h) { … }`, except in popup mode where the float closes.

- [ ] **Step 4: Run to verify they pass**

Run: `bun test packages/cli packages/tui && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages
git commit -m "feat(cli): open sessions across Rex and tmux"
```

## Task 9: tmux sessions in a Rex tab

**Files:**
- Modify: `packages/cli/src/open-row.ts`, `dash-actions.ts`, `attach.ts`
- Test: `packages/cli/tests/open-row.test.ts`, `dash-actions.test.ts`

**Interfaces:**
- Consumes: `planOpen`'s `"tmux-tab"`, `rexNewLabelledTab`, `findLabelledBlock`, `rexFocus`, `buildAttachCommands`.
- Produces:
  - `tmuxTabLabel(socket: string | null, session: string): string`, `agmux:tmux:<8 base36 chars>` from `Bun.hash(`${socket ?? ""}\0${session}`)`
  - `openTmuxTab(row, caller: PaneCoords, deps): Promise<void>`

- [ ] **Step 1: Write failing tests**

```ts
test("tmuxTabLabel is stable and has a fixed shape for odd names", () => {
  expect(tmuxTabLabel(null, "my work:1 #x")).toMatch(/^agmux:tmux:[0-9a-z]{1,8}$/);
});
test("two sessions on different sockets get different labels");
test("first open creates a tab running holdOnFailure(tmux attach-session ...)");
test("session names with spaces, ':' and '#' stay single argv elements");
test("';' separators are their own argv elements");
test("second open focuses the existing block and selects window and pane over -S");
test("two rows in one tmux session reuse one tab");
test("a stale label whose block has gone opens a new tab");
test("in a popup returns empty argv; in an inline dash returns null");
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test packages/cli/tests/open-row.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

The tab's command is `["tmux", ...buildAttachCommands(coords, false)[0]]`, wrapped with `holdOnFailure`. Task 1 decided: do not use `--shell=none`. The default login shell preserves `;`, spaces and JSON in argv and gives the full PATH (homebrew, nvm); with `--shell=none` the PATH is only `~/.local/bin:/usr/local/bin:/usr/bin:/bin:...` plus the Rex app directory, so `tmux` from `/opt/homebrew/bin` would not be found. The dedup branch runs `buildAttachCommands`' `select-window` and `select-pane` as tmux commands against the row's socket.

- [ ] **Step 4: Run to verify they pass**

Run: `bun test packages/cli/tests/open-row.test.ts packages/cli/tests/dash-actions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages
git commit -m "feat(cli): show live tmux sessions in a Rex tab"
```

## Task 10: Remote sessions opened from Rex

**Files:**
- Modify: `packages/cli/src/attach-remote.ts:49-125`, `dash-actions.ts:77-80`
- Test: `packages/cli/tests/attach-remote.test.ts`

**Interfaces:**
- Consumes: `placementOps`, `rexNewLabelledTab`, `findLabelledBlock`, `rexFocus`.
- Produces: `remoteTabLabel(sessionId: string, mode: RemoteAttachMode): string`, `agmux:remote:<id8>:<mode>`

- [ ] **Step 1: Write failing tests**

```ts
test("in Rex the default mode is the configured mode (view), not full");
test("in Rex new-window opens a labelled tab running the remote client");
test("in Rex an existing labelled block is focused, no second client starts");
test("view and full of one session get different labels");
test("inline in Rex returns the client argv and sets no label");
test("tmux remote attach tests pass unchanged");
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test packages/cli/tests/attach-remote.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Branch `attachRemote` on `detectMux(process.env)`: Rex uses `findLabelledBlock` where tmux uses `findRemotePane`, and Rex placements where tmux uses `deps.splitPane`, `deps.newWindow` and `deps.newSession`. Add those as optional deps so tests inject them. `remote-client.ts` is unchanged.

- [ ] **Step 4: Run to verify they pass**

Run: `bun test packages/cli/tests/attach-remote.test.ts packages/cli/tests/remote-client.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages
git commit -m "feat(cli): open remote sessions from Rex"
```

## Task 11: Signals, highlight and seen

**Files:**
- Modify: `packages/cli/src/pane-signals.ts:64-114`, `notifyd.ts`, `bin/agmux.ts`, `seen.ts:83-95`, `packages/tui/src/opentui/attached.ts:22-33`, `run-manage.tsx:52`
- Test: `packages/cli/tests/pane-signals.test.ts`, `packages/cli/tests/seen.test.ts`, `packages/tui/tests/opentui/attached.test.ts`

**Interfaces:**
- Consumes: `rexTitle`, `rowMux`, `RexExec`.
- Produces:
  - `PaneSignalDeps.rexTitle?: (row: SessionRow) => Promise<string | null>`
  - `activeLocation(env?, runTmux?, rexExec?): Promise<{ pane: string; socket: string | null } | null>` replacing `activePaneId`

`packages/tui` can't import `packages/cli`, so the Rex lookup in `activeLocation` is passed in from `dash.ts` as `rexActivePane: () => Promise<string | null>`, implemented with `rexCurrentPane(env, popup)`.

- [ ] **Step 1: Write failing tests**

```ts
test("native rex rows get title.changed from rexTitle");
test("rex rows never go to tmux list-panes or list-clients");
test("a done rex row is not marked seen by focus");
test("a null rexTitle skips the row without throwing");
test("seen --pane block:… skips the tmux option read and matches tmux_pane");
test("activeLocation in Rex returns the underlying block and REX_SERVER");
test("activeLocation in Rex with no underlying block returns null");
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test packages/cli/tests/pane-signals.test.ts packages/cli/tests/seen.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `collectPaneSignals`, rename `inTmux` to `withPane` and filter tmux work to `rowMux(r) === "tmux"`. Rex native rows use `rexTitle` then the same `TitleSignal` path, polled at the same interval as tmux rows. Task 1 measured 28 ms per `title` call (26 to 30 ms over 20 calls), so no extra floor is needed. `resolvePane` skips `readPaneOption` when `pane.startsWith("block:")`. `isPaneVisible` needs no change: a block id never appears in tmux's list.

- [ ] **Step 4: Run to verify they pass**

Run: `bun test packages/cli packages/tui`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages
git commit -m "feat(cli): carry titles, seen and highlight to Rex"
```

## Task 12: Display

**Files:**
- Modify: `packages/protocol/src/mux.ts`, `packages/tui/src/shared/columns.ts:57-58,79`, `search.ts:7`, `yank.ts:9-14,28`, `statusline.ts:155-157`, `packages/cli/src/sinks.ts:44`
- Test: `packages/protocol/tests/mux.test.ts`, the matching `packages/tui/tests/shared/*.test.ts`, `packages/cli/tests/sinks.test.ts`

**Interfaces:**
- Consumes: `SessionRow.mux`, `mux_label`.
- Produces: `muxLocationText(row): string`: `""` with no location, `rex:<label>` for Rex, `<session>:<window>` for tmux

- [ ] **Step 1: Write failing tests**

```ts
test("muxLocationText", () => {
  expect(muxLocationText({ mux: null, mux_label: null, tmux_session: "work", tmux_window: "@1" })).toBe("work:@1");
  expect(muxLocationText({ mux: "rex", mux_label: "bold-creek", tmux_session: "session:01a1-abcd1234", tmux_window: "window:x" })).toBe("rex:bold-creek");
  expect(muxLocationText({ mux: "rex", mux_label: null, tmux_session: "session:01a1-abcd1234", tmux_window: null })).toBe("rex:abcd1234");
  expect(muxLocationText({ mux: null, mux_label: null, tmux_session: null, tmux_window: null })).toBe("");
});
test("column header reads MUX and the config key stays tmux");
test("search matches a rex label");
test("yank shows rex:<label> under MUX");
test("statusline: a rex label with '#' is doubled and control chars are stripped");
test("statusline: tmux_window and tmux_pane are empty for rex rows");
test("notification body uses rex:<label>, never a UUID");
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test packages/protocol packages/tui/tests/shared packages/cli/tests/sinks.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

The column key stays `"tmux"`, so saved column config keeps working. Only the header changes. Use `stripControls` on `mux_label` in the helper; the status line's existing `#` escaping handles the rest. Tmux output must stay exactly as it is today.

- [ ] **Step 4: Run to verify they pass**

Run: `bun test packages/protocol packages/tui packages/cli/tests/sinks.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages
git commit -m "feat(tui): show Rex locations by label"
```

## Task 13: Audit, docs and smoke test

**Files:**
- Modify: `docs/agmux-foundation.md` (§4 fields, §14.5), `README.md`, `CONTRIBUTING.md`, `packages/cli/AGENTS.md`, `packages/adapters/src/skills/agmux-overview.ts`, `CHANGELOG.md`
- Modify: any file the audit finds

- [ ] **Step 1: Audit every read of a location field**

Run: `git grep -n -E 'tmux_(session|window|pane|socket|server)' -- 'packages/**/src/**'`
For each hit that reaches a command, confirm it branches on `rowMux`. Fix any that don't, with a test.

- [ ] **Step 2: Update docs**

Foundation: note `mux` in the session model, and extend standing principle 5 to read "tmux and Rex are first-class orchestration substrates". `packages/cli/AGENTS.md`: add a Rex section with the helper rules, Task 1's findings and limits L1 to L4. Keep the `agmux-overview` skill accurate about detection.

- [ ] **Step 3: Run everything**

Run: `bun run typecheck && bun test`
Expected: all pass.

- [ ] **Step 4: Run the smoke list inside real Rex**

Work through spec §7's 11 smoke items and record each result in `docs/spikes/2026-11-02-rex/REPORT.md`. Item 10 needs a sandbox: if none is available, mark it not run and say so at handoff. Add L4 as a twelfth item: autostart a Rex server from inside tmux (`TMUX` set) and check that `env | grep TMUX` in its blocks is empty; if it leaks, `detectMux` needs the `REX_BLOCK`-first rule and the docs must say so. Task 1 could not test this without restarting the real server. Any failure gets a test and a fix before moving on.

- [ ] **Step 5: Commit**

```bash
git add docs packages CHANGELOG.md README.md CONTRIBUTING.md
git commit -m "docs(rex): document Rex support and record smoke results"
```
