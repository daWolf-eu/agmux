# Attention Signals — Design

**Date:** 2026-09-11
**Branch:** `feat/attention-signals`
**Status:** design approved; implementation plan pending

Ambient and active signalling for agent sessions that need you: an always-visible
tmux status line, a non-blocking in-tmux toast, and a native macOS notification —
gated by a read/unread model so you are told about each event once.

---

## 1. Problem

`agmux dash` answers "what are my agents doing?" only when you go and ask it. Between
visits there is no signal, so a session that blocked on a permission prompt thirty
seconds after you looked away stays blocked until you next open the dash. The cost is
not the dash — it is the polling you have to do with your own attention.

Two surfaces close that gap: something **always visible** that needs no keystroke, and
something **active** that reaches you when you are not looking at the terminal at all.

## 2. What the spike settled

A spike on 2026-09-11 probed the delivery mechanisms on the target machine (tmux 3.6a,
macOS 26.6.2, Ghostty 1.3.1). Findings that constrain this design:

| Mechanism | Verdict | Evidence |
|---|---|---|
| Multi-line status (`status 2` + `status-format[1]`) | **Works** | Verified by capturing a nested client's painted screen; `#(...)` re-expands each `status-interval`. |
| `display-popup` as a passive toast | **Rejected** | Manual: *"Panes are not updated while a popup is present."* Keystrokes sent during a popup were discarded outright, not queued. |
| `display-message` | **Works** | Non-blocking, paints in the status area, honours `display-time`, targetable per-client with `-c`. |
| Terminal-native OSC 9 / OSC 777 | **Rejected** | Produced nothing in any arrangement, including from a visible pane with `allow-passthrough on`, despite Ghostty defaulting `desktop-notifications = true`. |
| `osascript` notification | **Works** | Banner + sound. Three fired twelve seconds apart all delivered — no coalescing or rate-limiting. |
| Sound (`sound name`, `afplay`) | **Works, independently of the banner** | A bare `afplay` is audible with no notification attached. |

Two constraints follow and are binding on this design:

1. **Nothing may take over the screen to get attention.** The popup's keystroke
   destruction and the OSC test's window flash both demonstrated the failure mode.
   Every signal here is either passive (status line), transient and non-blocking
   (`display-message`), or out-of-band (OS notification).
2. **Notification delivery is not statically determinable.** A flag-clustering analysis
   of `com.apple.ncprefs` predicted the wrong winner with high confidence. `osascript`
   returns exit 0 whether or not a human saw anything. agmux must never report delivery
   as success, and must not silently assume a notifier works.

## 3. Scope

**In scope**

- A second tmux status line (or `status-right`) listing live sessions with status glyphs.
- Debounced, focus-aware notifications: in-tmux toast and native OS notification.
- A read/unread model so each attention-worthy event notifies once.
- Configuration for all of the above in `~/.config/agmux/config.toml`.
- Extension of `agmux.tmux` with the options and key bindings.

**Out of scope**

- Replacing or restyling `agmux dash`.
- Push/SSE transport for the hub (backlog 08). This design uses the existing polling
  `SessionFeed` and inherits streaming for free when it lands.
- Remote or cross-host notification. Principle 1: localhost only.
- Linux delivery beyond making the notifier command configurable so `notify-send` works.

## 4. Alignment with standing principles

`AGENTS.md` makes `docs/agmux-foundation.md` §14 authoritative. Two principles shape the
design materially:

- **§14.3 — "Event log is truth; projections are derived and rebuildable."** Read/unread
  state is therefore *not* a mutable flag. Marking a session seen appends a
  `session.seen` event; the unread flag is a projection over the log and is rebuildable
  from it like `session_usage` and `session_activity`.
- **§14.7 — "Event schema evolves additively."** `session.seen` is a new kind; unknown
  kinds are already stored raw, so older hubs tolerate it.
- **§14.6 — "Each consumer package is optional; the foundation is small."** The daemon is
  a consumer over the query API. It adds no new package: formatting lives in
  `@agmux/tui` beside the existing glyph and column helpers, the command lives in
  `@agmux/cli` beside `watch`, which already composes `@agmux/tui`'s feed the same way.

## 5. The unread model

### What makes a session unread

Three event kinds already carry the meaning "this session wants you":

| Event | Meaning |
|---|---|
| `input.required` | Blocked on a prompt, permission, or confirmation. |
| `turn.ended` | Finished a turn; output is waiting to be read. |
| `session.ended` | Session finished or exited. |

A session is **unread** when its most recent event of one of those kinds is newer than
its most recent `session.seen` event. `session_activity.activity_ts` already records the
former; the projection adds the latter.

### What marks a session seen

Two paths, per the approved semantics:

1. **Attaching.** `agmux attach` (and the dash's attach action) appends `session.seen`
   for the target session before handing over the terminal.
2. **Explicit dismissal.** A key in `dash` (`u`) marks the highlighted session read.
   This allows triage of a list without visiting each session.

   Mark-unread was deliberately dropped, despite being in the original plan. `seen_ts`
   is written by a `MAX` upsert (monotonic), specifically so that a `session.seen`
   event arriving late — e.g. queued to disk while the hub was down, then flushed after
   restart — can never un-see an acknowledgement that is newer than it. A toggle-back-
   to-unread action is incompatible with that guarantee: it would need a new event kind
   (there is no "mark unread" event in the protocol) plus new projection rules to
   arbitrate ordering against the monotonic `seen_ts`, and nobody has designed those. So
   `u` only ever moves a session from unread to read; a session returns to unread only
   the ordinary way, via its next attention event (`input.required` / `turn.ended` /
   `session.ended`). Do not re-add a toggle without solving the ordering problem above.

Nothing else clears an unread. In particular, a session appearing in the status line
does **not** mark it seen — an ambient surface you may not have looked at cannot be
treated as acknowledgement, or the flag means nothing.

### Notification vs unread

The unread flag and the notification debounce are separate concerns and must not be
conflated:

- **Unread** is durable state — it persists until you attach or dismiss.
- **Notified** is a one-shot the daemon tracks in memory for the current run, so a
  restarted daemon does not re-announce a backlog.

A session that is unread but already notified stays visibly unread in the status line
without firing again. This is the mechanism that makes "an agent asked three permissions
in a row" quiet.

## 6. Architecture

One watcher, three sinks. The watcher subscribes to the existing `SessionFeed`; each
sink is independently disableable.

```
hub /sessions ──► SessionFeed (existing, polling)
                      │
                      ▼
              agmux notifyd  ─── renders ──► cache file ──► status-format[1]  (ambient)
                      │
                      ├── debounce + focus check ──► tmux display-message      (transient)
                      └── debounce + focus check ──► notifier command          (away)
```

### Components

| Component | Package | Responsibility |
|---|---|---|
| `session.seen` event + payload type | `@agmux/protocol` | New kind, version 1. Additive. |
| `session_seen` projection | `@agmux/store` | Schema v6. `session_id` PK, `seen_ts`. Rebuildable from the log. |
| `unread` on `SessionRow` | `@agmux/store` / `@agmux/protocol` | Derived in the query, joined like `turn_count`. |
| `?unread=1` filter | `@agmux/hub` | Query-API filter, same shape as the existing `status` filter. |
| `formatStatusLine(rows, opts)` | `@agmux/tui` | Pure function → tmux-format string. Reuses `statusGlyph`. |
| Transition detection | `@agmux/tui` | Pure function: previous rows + current rows + config → list of notifications to fire. |
| `agmux notifyd` | `@agmux/cli` | Long-running daemon: feed → formatter → cache file; transitions → sinks. |
| `agmux statusline` | `@agmux/cli` | One-shot render to stdout. The no-daemon fallback and the debugging surface. |
| `agmux seen <id>` / `--unseen` | `@agmux/cli` | Emits `session.seen`. Used by `attach` and by dash. |
| Options + bindings | `agmux.tmux` | Wires the status line and mouse binding; degrades below tmux 3.3. |

### Why the status line reads a cache file

`status-format` is expanded **per attached client, per `status-interval` tick**. Putting
`#(agmux statusline)` there forks a process every second for every terminal. The daemon
therefore renders once and writes `$XDG_RUNTIME_DIR/agmux/statusline` (falling back to
`~/.cache/agmux/statusline`), and the format string only runs `cat`. Writes are atomic
(write temp, rename) so a client never paints a half-written line.

If the daemon is not running, the file goes stale. The daemon writes a heartbeat
timestamp alongside it; `agmux statusline --check` reports staleness, and the rendered
line degrades to a dim `agmux: stale` marker rather than confidently showing wrong state.

### Focus suppression

A notification is suppressed when you are already looking at the session. "Looking at" is
resolved as: an attached tmux client exists whose active pane is the session's
`tmux_pane`. This is queryable via `tmux list-clients` / `display-message -p`.

The honest limit: tmux knows which pane is active in an attached client, but **not**
whether the terminal emulator itself has OS focus. A pane can be "active" while the
terminal sits behind a browser. The design therefore treats tmux-active as suppressing
the *tmux toast* (which you could only see in tmux anyway) but **not** the OS
notification, which is precisely the signal that should fire when you have tabbed away.
This asymmetry is deliberate and should be documented, not smoothed over.

## 7. Configuration

New sections in `~/.config/agmux/config.toml`, alongside the existing `[ls]` defaults
convention. All keys optional; the defaults below apply when absent.

```toml
[notify]
enabled        = true
delay          = "5s"      # dwell in `waiting` before notifying; 0 disables debounce
triggers       = ["permission", "prompt", "turn_end", "session_end"]
sound          = true
sound_name     = "Ping"    # macOS sound; per-trigger override below
command        = "auto"    # auto | osascript | terminal-notifier | notify-send | <custom>
tmux_message   = true      # the in-tmux display-message toast
suppress_when_visible = true

[notify.sounds]            # optional per-trigger overrides
permission  = "Sosumi"
session_end = "Hero"

[statusline]
enabled  = true
position = "status2"       # status2 | status-right | off
show     = "all"           # all | unread | waiting
max      = 6               # max sessions rendered; overflow collapses to a "+N" chip
format   = "{glyph} {tmux_session}:{tmux_window}"
sort     = "activity"      # reuses the existing ls sort vocabulary
```

Notes on specific keys:

- **`command = "auto"`** resolves at runtime in order: `terminal-notifier` (correct app
  identity, and the only path that can open the blocked session on click), then
  `osascript`, then `notify-send`. A custom string is run as-is with substitution
  variables, which is what makes non-macOS and unusual setups work without a code change.
- **`show`** defaults to `all`, which is the always-visible-everything mode and the
  original motivation for the status line — seeing every running agent without asking.
  `unread` narrows it to sessions that want you;
  `waiting` shows only currently-blocked sessions and ignores unread entirely, for users
  who do not want the read/unread concept at all.
- **`delay`** accepts a duration string (`"5s"`, `"2m"`) or a bare integer read as
  seconds. It is parsed once at config load; an unparseable value is a startup error,
  not a silent fallback to zero, which would turn the debounce off without telling anyone.
- **`triggers`** selects which transitions notify, and maps to already-emitted events:
  `permission` and `prompt` are `input.required` discriminated by `last_input_kind`
  (`confirm` is folded into `permission`); `turn_end` is `turn.ended`; `session_end`
  covers `session.ended` and the `lost` status.
- **`format`** substitutes `{glyph}`, `{tmux_session}`, `{tmux_window}`, `{tmux_pane}`,
  `{project}`, `{agent_kind}`, `{status}`, `{session_id}` (short form), and
  `{last_tool}`. (An `{age}` field, relative time via the existing `reltime` helper, was
  planned here but was not implemented — `formatStatusLine` in
  `packages/tui/src/shared/statusline.ts` has no `age` case, so as of this writing
  `{age}` renders empty like any other unrecognised key. Add it there before
  documenting it as supported.) Null fields render empty, and the surrounding separator
  collapses rather than leaving a dangling `:` or `/`. An unrecognised placeholder
  behaves the same way — it renders empty and its separator collapses — it is not
  passed through literally (contrast the `notify.command` custom-notifier placeholders
  in `packages/cli/src/notifier.ts`, which pass an unrecognised `{token}` through
  unchanged). `{tmux_session}` is abbreviated to fit `max` entries on one line —
  truncated from the middle, which keeps a numeric or branch-like suffix legible.

  The default is `{glyph} {tmux_session}:{tmux_window}` because the status line's job is
  to let you *identify which session this is and go there*, and the tmux coordinates are
  the only fields that reliably do that today. `profile` is deliberately excluded: it
  names how a session was launched, not which conversation it is, so several concurrent
  sessions routinely share one profile and the line stops being discriminating.

  This is the weakest part of the design, and it is a data problem rather than a
  formatting one — agmux has no human-meaningful session label yet. The natural fix is a
  session **title**, sourced per agent (some agents name their sessions; others could
  have one derived from the first exchange) and carried as an additive event. That is out
  of scope here, but the format vocabulary is the seam it would plug into: adding
  `{title}` later is a new substitution and a new default string, not a redesign.
- **`sound`** is separate from whether a banner appears, because the spike showed they
  are independently controllable and sound is the channel that works when nothing is on
  screen.

## 8. tmux plugin surface

`agmux.tmux` gains, alongside the existing `@agmux-key`:

| Option | Default | Effect |
|---|---|---|
| `@agmux-statusline` | `off` | `on` enables the second status line. Opt-in — it changes the user's status bar. |
| `@agmux-statusline-position` | `status2` | `status2` or `status-right`. |
| `@agmux-statusline-interval` | `2` | Sets `status-interval`. |
| `@agmux-mark-read-key` | `u` | Prefix key to mark the current pane's session read. |
| `@agmux-statusline-mouse` | `on` | Makes status-line entries clickable (attach on click). Opt-out, because it installs a root-table `MouseDown1Status` binding that can collide with a user's own mouse bindings. |

Behaviour:

- If `tmux -V` reports < 3.3, `status2` is unavailable; the plugin falls back to
  `status-right` and emits a one-line `display-message` explaining the downgrade.
- The plugin **never** enables `allow-passthrough` or any other global option the user
  did not ask for. (The spike found passthrough irrelevant anyway, since the OSC path is
  not shipping.)
- Clickable tabs use `#[range=user|<session-id>]` with a `MouseDown1Status` binding
  dispatching to `agmux attach`. tmux accepts the binding and the mechanism is
  documented; it is built as designed and confirmed during manual QA rather than gated
  behind a flag. The one thing implementation must not assume is that a click always
  resolves — `#{mouse_status_range}` is empty when the click lands outside any range, and
  that case must no-op silently rather than attaching to something arbitrary.

## 9. Error handling

| Failure | Behaviour |
|---|---|
| Hub unreachable | Feed already surfaces `onError`. Daemon keeps running, writes a dim `agmux: hub down` line, retries on the next tick. No notification storm. |
| Notifier command missing | Detected once at startup; logged; that sink disables itself. Other sinks keep working. |
| Notifier exits non-zero | Logged once per command, not per event. Never retried — a retry loop on a notifier is a notification storm. |
| Notifier exits zero | **Not** treated as proof of delivery. The spike showed `osascript` returns 0 when suppressed. |
| Cache file unwritable | Daemon logs and continues; the status line degrades to stale. |
| Daemon not running | `#(cat)` yields empty; status line shows nothing rather than an error. |
| tmux absent | Toast sink disables itself; OS notification and status line are unaffected (the latter is moot without tmux). |

## 10. Testing

Following the repo's existing test layout (`packages/*/tests`, `bun test`):

- **Pure functions carry the logic, and are the main test surface.**
  `formatStatusLine(rows, opts)` and the transition detector are both pure: rows in,
  string or notification-list out. They are tested against `mk-row.ts` fixtures, which
  already exist in `packages/tui/tests/helpers/`.
- **Debounce and dedup** are tested with an injected clock, matching the existing
  `setIntervalImpl` injection pattern in `feed.ts` — no sleeping tests.
- **The projection** is tested at the store layer: append `input.required`, assert
  unread; append `session.seen`, assert read; rebuild projections from the log and assert
  the flag survives, which is the §14.3 guarantee.
- **Shell-outs are injected**, never executed in tests. The notifier and every `tmux`
  invocation go through a `run(cmd, args)` seam so tests assert the argv that *would*
  have been run.
- **Not unit-tested:** whether a notification is actually visible to a human. That is
  unfalsifiable in CI and is exactly what the spike established manually. The design
  compensates by never treating exit 0 as delivery.

## 11. Build order

**This ships as one feature.** The stages below are an implementation and commit
sequence on `feat/attention-signals`, not separate releases — the branch merges once,
with the whole feature present. The ordering exists because each stage is independently
*testable* and leaves the tree green, which keeps the commit history readable and
bisectable; it is not an invitation to stop after stage 1.

1. **Status line.** Daemon, formatter, cache file, `agmux statusline`, plugin options,
   `status-right` fallback. `show` supports `all` and `waiting`; `unread` arrives with
   stage 2. Delivers the always-visible dash and carries the most value per unit of risk.
2. **The unread model.** `session.seen` event, `session_seen` projection, schema v6,
   `unread` on `SessionRow`, `?unread=1`, `agmux seen`, attach integration, dash keys.
   Enables `show = "unread"`.
3. **Notifications.** Transition detection, debounce, focus suppression, the
   `display-message` toast, the pluggable notifier with runtime detection, sound.
4. **Mouse and polish.** Clickable status entries, `terminal-notifier` click-to-attach,
   overflow chip, staleness marker.

## 12. Decisions and known limits

- **The tmux version floor stays at 3.2.** Multi-line status needs 3.3, but the only
  consequence below it is the `status-right` fallback, which is a graceful downgrade
  rather than a broken feature. The README is left as-is; no floor bump.
- **Click-to-attach is built as designed, verified manually.** Neither the status-line
  mouse binding nor `terminal-notifier`'s click action has an end-to-end test, and
  `terminal-notifier` is not installed on the target machine. Both are implemented on the
  assumption they behave as documented and confirmed during manual QA; a failure comes
  back as a fix, not as a blocked stage.
- **Terminal OS-focus is not knowable from tmux.** A deliberate asymmetry, described in
  §6: pane-active suppresses the tmux toast but never the OS notification.
- **Sessions have no human-meaningful label.** The status line falls back to tmux
  coordinates. A session `title` is the real fix and is out of scope; §7 records the seam
  it plugs into.
