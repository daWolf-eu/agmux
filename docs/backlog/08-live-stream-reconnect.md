# Pitch 08 — Live-stream reconnect contract (snapshot + dedup, no replay)

**Source:** omnigent · **Target package(s):** `@agmux/hub` (query API), `@agmux/tui`, `@agmux/dashboard` · **agmux concern:** live consumer sync

---

## Handoff context (read first)

agmux's hub exposes a query API that consumers read; "consumers needing live state read the fast projection,
analytics reads the raw log" (foundation §6). The TUI and dashboard are *live* consumers that must show
sessions updating in real time and survive disconnects (laptop sleep, network blips, distributed (B)). This
finding is the proven contract for doing that cheaply. Read
[`../agmux-foundation.md`](../agmux-foundation.md) §3, §6, §12 (`hub`, `tui`, `dashboard`).

This is a **design pitch / spike**. Reference codebase: `https://github.com/omnigent-ai/omnigent` (grep; lines drift).

## What omnigent does

omnigent fans live events to browser/phone/terminal with a deliberately minimal, **no-replay** design:

- **Durable ordered log + ephemeral live fan-out.** Each item is a row with a monotonic per-conversation
  `position` cursor; `session_stream.publish()` (`omnigent/runtime/session_stream.py:52`) fans events to
  per-subscriber asyncio queues via `call_soon_threadsafe`. The live stream keeps **no buffer and no replay**.
- **Reconnect contract.** A reconnecting client (a) opens the live SSE stream, (b) GETs a *snapshot* of
  current state, (c) **dedupes by stable server-issued item id**. Stable ids make terminal/browser/phone
  converge on identical ordered state without an event-replay mechanism (`server/routes/sessions.py:16880`).
- **Delta coalescing for late joiners.** `inflight_text.py:118` accumulates per-turn streaming deltas, dedupes
  native single-chunk races, and serves a gap-free snapshot so a client that joins mid-turn isn't missing text.
- **Presence for free.** Holding the stream registers the caller as a viewer; the snapshot lists co-viewers.

## Why it matters for agmux

- agmux already has the hard part — an append-only log with derived, rebuildable projections (§6). The
  reconnect contract (snapshot + dedup-by-id) is *far simpler* than event-sourced replay and is exactly what
  the TUI/dashboard need to stay live and resilient. agmux's monotonic event ordering maps onto the `position`
  cursor directly.
- The publish/subscribe seam is the right abstraction boundary for distributed (B): omnigent's in-process bus
  won't survive multi-process, so agmux should put the *same* `publish/subscribe` interface in front of a
  backend that can later become Postgres `LISTEN/NOTIFY` or Redis — without changing consumers.
- Coalescing/late-join snapshot matters once agmux surfaces in-session text deltas (from Pitch 01 adapters).

## Plan outline

1. Define the hub's live-stream API: a subscribe endpoint (SSE/WebSocket, localhost/tunnel-bound per §11) +
   a snapshot endpoint returning current projection state with stable ids.
2. Specify the **reconnect contract** for consumers: open stream → fetch snapshot → dedup by event/item id.
   Document it once; TUI and dashboard both implement it.
3. Put `publish/subscribe` behind an interface (in-process for baseline A; pluggable for B) so distribution is
   additive, never a rewrite (§ standing principle 4).
4. Optional: a small per-session coalescing layer for streaming text deltas, ported from `inflight_text`.
5. Prototype: TUI shows a live session, is killed mid-session, reconnects, and converges with zero dupes/gaps.

## Deliverable

A "live consumer sync" design doc (subscribe + snapshot + dedup contract, and the pub/sub interface for B),
plus a TUI reconnect spike. Reuse omnigent's snapshot+dedup and coalescing patterns; **skip** its
runner↔server tunnel/relay (agmux distribution rides the user's own secure transport, §11).
