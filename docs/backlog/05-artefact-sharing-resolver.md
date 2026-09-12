# Pitch 05 — Artefact store + `file_id → data:` resolver

**Source:** omnigent · **Target package(s):** `@agmux/store` (+ a new artefact service) · **agmux concern:** cross-harness data/artefact sharing

---

## Handoff context (read first)

agmux unifies session *events* today (foundation §6). It does **not** yet have a story for sharing **work
artefacts** (files, images, outputs) between agents or between an agent and a consumer. This is a net-new
capability pitch. Read [`../agmux-foundation.md`](../agmux-foundation.md) §3 (hub owns the store), §6 (one
unified DB, append-only log + projections), §12 (`store`).

This is a **design pitch / spike**. Reference codebase: `https://github.com/omnigent-ai/omnigent` (grep; lines drift).

## What omnigent does

Two complementary mechanisms:

1. **Metadata/blob split.** `FileStore` (SQL) holds file *metadata* — id, filename, bytes, content_type,
   `session_id` (`omnigent/stores/file_store/sqlalchemy_store.py:35`). `ArtifactStore` holds the raw *bytes*
   keyed by the **same opaque id** (`stores/artifact_store/__init__.py:6`). `FileStore.create()` returns a
   `file_id`; `ArtifactStore.put(file_id, bytes)` stores under it; reads reverse it. No FK gymnastics — the
   shared id is the join.
2. **`file_id → data: URI` resolver** (`omnigent/runtime/content_resolver.py:251`,
   `resolve_content_references`). When a message references `{file_id}`, it rewrites the block to an inline
   `data:` URI: `file_store.get` (ownership check) → `artifact_store.get` → `base64` → `image_url`/`file_data`,
   with a per-turn base64 cache. **This is the provider-agnostic primitive** that makes an artefact produced
   under harness A visible inside harness B's next message, regardless of vendor.

Download path forces `Content-Disposition: attachment` + `X-Content-Type-Options: nosniff` to defuse stored
XSS (`sessions.py:15322`).

## Why it matters for agmux

- agmux already declares "one unified DB" with events; adding an artefact layer keyed by `session_id` fits §6
  cleanly — artefacts become first-class, queryable rows alongside events.
- The resolver is the single most reusable idea for agmux's multi-agent premise: store once, inject inline at
  message-build time, agent-agnostic by construction (§4). It pairs naturally with the `comms` message flow.
- Keeps agmux local-first: blobs on local FS in baseline (A), swappable for object storage in distributed (B),
  behind the same store interface — mirroring agmux's SQLite→Postgres-portable stance.

## Plan outline

1. Decide scope: is artefact sharing a `store` extension or a new opt-in consumer? Recommend store-level
   metadata + a thin artefact service, since the hub owns the only writer (§3).
2. Schema: an `artifacts` table (id, session_id, filename, content_type, bytes, created_at) + a blob backend
   interface (local FS baseline; object-store-ready for B). Keep events referencing artefacts by id.
3. Port the resolver concept: a hub/query-API helper that turns an `artifact_id` into an inline payload for an
   agent message, with the per-turn cache and ownership/scope check.
4. Define how an artefact gets *registered* — prefer "harness/adapter pushes the artefact" over agmux
   proxying every filesystem op (skip omnigent's heavy per-op RPC `OSEnvironment`).
5. Carry over the download hardening (`attachment` + `nosniff`) if any consumer serves artefacts to a browser.

## Plan note / deliverable

A design doc placing artefacts in agmux's data model + a spike: store a file under one session, resolve it
into a message for another agent. Reuse the metadata/blob split and resolver pattern; **drop** the WS HTTP
tunnel and per-op filesystem RPC unless agmux later needs to drive remote sandboxes itself.
