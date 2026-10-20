import type { Server } from "bun";
import type { Store } from "@agmux/store";
import type { IngestEnvelope, RemoteSyncState } from "@agmux/protocol";
import { validateIngestEnvelope, validateKnownPayload, AGMUX_VERSION, expandStatusFilter } from "@agmux/protocol";
import type { SessionStatus, Locality } from "@agmux/protocol";

const EXPORT_DEFAULT_LIMIT = 500;
export const EXPORT_MAX_LIMIT = 5000;
// Cap on a POST /ingest body (one event or a batch). Every event a sandbox's
// hub ingests is replicated to the Mac as one stream line, which the follower
// caps at MAX_LINE_BYTES (also 1 MiB): capping here keeps them from piling up.
export const INGEST_MAX_BODY_BYTES = 1 << 20;

export interface CreateServerOpts {
  store: Store;
  port: number;     // 0 → ephemeral
  hostname?: string; // default 127.0.0.1
  // In-memory sync state for GET /hosts (absent = no sync loop, e.g. in a sandbox).
  remotes?: () => RemoteSyncState[];
}

export function createServer(opts: CreateServerOpts): Server<undefined> {
  const { store } = opts;
  const hostname = opts.hostname ?? "127.0.0.1";

  return Bun.serve({
    port: opts.port,
    hostname,
    // Bun answers 413 itself when a declared or streamed body passes this.
    maxRequestBodySize: INGEST_MAX_BODY_BYTES,
    fetch: async (req) => {
      const url = new URL(req.url);
      const m = req.method;

      if (m === "GET" && url.pathname === "/health") {
        // version lets `agmux hub status` flag a stale running hub vs the installed binary.
        return Response.json({ ok: true, version: AGMUX_VERSION, db_id: store.dbId() });
      }

      if (m === "POST" && url.pathname === "/ingest") {
        let body: unknown;
        try { body = await req.json(); } catch { return Response.json({ error: "invalid_json" }, { status: 400 }); }
        const events = Array.isArray(body) ? body : [body];
        for (const ev of events) {
          const env = validateIngestEnvelope(ev);
          if (!env.ok) return Response.json({ error: env.error }, { status: 400 });
          const e = ev as IngestEnvelope;
          // host.* events are written by the hub itself (Store.append), never ingested.
          if (e.kind.startsWith("host.")) return Response.json({ error: "reserved_kind" }, { status: 400 });
          const pl = validateKnownPayload(e.kind, e.payload);
          if (!pl.ok) return Response.json({ error: pl.error }, { status: 400 });
          store.resolveAndAppend(e); // resolves native identity, idempotent, drops unresolvable telemetry
        }
        return new Response(null, { status: 202 });
      }

      if (m === "GET" && url.pathname === "/sessions") {
        // Status filter is opt-in (?status=<group|csv>; ?live=1 is the legacy
        // alias for status=open). Default returns all statuses so recently-ended
        // sessions remain discoverable for `agmux attach`.
        const live = url.searchParams.get("live") === "1";
        const agent_kind = url.searchParams.get("agent_kind") ?? undefined;
        const profile = url.searchParams.get("profile") ?? undefined;
        const since = url.searchParams.get("since") ?? undefined;
        const limit = url.searchParams.get("limit");
        const sort = url.searchParams.get("sort") ?? undefined;
        const order = url.searchParams.get("order") ?? undefined;
        const status = url.searchParams.get("status") ?? undefined;
        const host = url.searchParams.get("host") ?? undefined;
        const localityParam = url.searchParams.get("locality") ?? undefined;
        if (localityParam !== undefined && localityParam !== "local" && localityParam !== "remote")
          return Response.json({ error: "invalid_locality" }, { status: 400 });
        const locality: Locality | undefined = localityParam;
        if (sort !== undefined && sort !== "started" && sort !== "activity")
          return Response.json({ error: "invalid_sort" }, { status: 400 });
        if (order !== undefined && order !== "asc" && order !== "desc")
          return Response.json({ error: "invalid_order" }, { status: 400 });
        let statuses: SessionStatus[] | undefined;
        if (status !== undefined) {
          const expanded = expandStatusFilter(status);
          if (!expanded) return Response.json({ error: "invalid_status" }, { status: 400 });
          statuses = expanded;
        }
        const sessions = store.listSessions({
          live,
          statuses,
          agent_kind,
          profile,
          host,
          locality,
          since,
          sort,
          order,
          limit: limit ? Number(limit) : undefined,
        });
        return Response.json({ sessions });
      }

      const mExplain = url.pathname.match(/^\/sessions\/([^/]+)\/explain$/);
      if (m === "GET" && mExplain) {
        const decision = store.explainSession(mExplain[1]!);
        if (!decision) return Response.json({ error: "not_found" }, { status: 404 });
        return Response.json({ decision });
      }

      const mSession = url.pathname.match(/^\/sessions\/([^/]+)$/);
      if (m === "GET" && mSession) {
        const sid = mSession[1]!;
        const session = store.getSession(sid);
        if (!session) return Response.json({ error: "not_found" }, { status: 404 });
        const events = store.listEvents({ session_id: sid, limit: 100 });
        const usage = store.getSessionUsage(sid);
        return Response.json({ session, events, usage });
      }

      if (m === "GET" && url.pathname === "/hosts") {
        // `remotes` is additive: older clients read `hosts` only.
        return Response.json({ hosts: store.listHosts(), remotes: opts.remotes?.() ?? [] });
      }

      if (m === "GET" && url.pathname === "/events") {
        // Cursor export for replication; the legacy filtered listing is below.
        const afterParam = url.searchParams.get("after_id");
        if (afterParam !== null) {
          if (!/^\d+$/.test(afterParam) || !Number.isSafeInteger(Number(afterParam)))
            return Response.json({ error: "invalid_after_id" }, { status: 400 });
          const limitParam = url.searchParams.get("limit");
          let limit = EXPORT_DEFAULT_LIMIT;
          if (limitParam !== null) {
            if (!/^\d+$/.test(limitParam) || Number(limitParam) < 1)
              return Response.json({ error: "invalid_limit" }, { status: 400 });
            limit = Math.min(Number(limitParam), EXPORT_MAX_LIMIT);
          }
          return Response.json(store.listExportable(Number(afterParam), limit));
        }
        const session_id = url.searchParams.get("session_id") ?? undefined;
        const kind = url.searchParams.get("kind") ?? undefined;
        const since = url.searchParams.get("since") ?? undefined;
        const limit = url.searchParams.get("limit");
        return Response.json({
          events: store.listEvents({
            session_id, kind, since,
            limit: limit ? Number(limit) : undefined,
          }),
        });
      }

      return new Response("not found", { status: 404 });
    },
  });
}
