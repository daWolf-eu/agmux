import type { Server } from "bun";
import type { Store } from "@agmux/store";
import type { EventEnvelope } from "@agmux/protocol";
import { validateEnvelope, validateKnownPayload } from "@agmux/protocol";

export interface CreateServerOpts {
  store: Store;
  port: number;     // 0 → ephemeral
  hostname?: string; // default 127.0.0.1
}

export function createServer(opts: CreateServerOpts): Server<undefined> {
  const { store } = opts;
  const hostname = opts.hostname ?? "127.0.0.1";

  return Bun.serve({
    port: opts.port,
    hostname,
    fetch: async (req) => {
      const url = new URL(req.url);
      const m = req.method;

      if (m === "GET" && url.pathname === "/health") {
        return Response.json({ ok: true });
      }

      if (m === "POST" && url.pathname === "/ingest") {
        let body: unknown;
        try { body = await req.json(); } catch { return Response.json({ error: "invalid_json" }, { status: 400 }); }
        const events = Array.isArray(body) ? body : [body];
        for (const ev of events) {
          const env = validateEnvelope(ev);
          if (!env.ok) return Response.json({ error: env.error }, { status: 400 });
          const e = ev as EventEnvelope;
          const pl = validateKnownPayload(e.kind, e.payload);
          if (!pl.ok) return Response.json({ error: pl.error }, { status: 400 });
          store.append(e); // idempotent
        }
        return new Response(null, { status: 202 });
      }

      if (m === "GET" && url.pathname === "/sessions") {
        // Live filter is opt-in via ?live=1. Default returns all statuses so
        // recently-ended sessions remain discoverable for `agmux attach`.
        const live = url.searchParams.get("live") === "1";
        const agent_kind = url.searchParams.get("agent_kind") ?? undefined;
        const profile = url.searchParams.get("profile") ?? undefined;
        const since = url.searchParams.get("since") ?? undefined;
        const limit = url.searchParams.get("limit");
        const sessions = store.listSessions({
          live,
          agent_kind,
          profile,
          since,
          limit: limit ? Number(limit) : undefined,
        });
        return Response.json({ sessions });
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

      if (m === "GET" && url.pathname === "/events") {
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
