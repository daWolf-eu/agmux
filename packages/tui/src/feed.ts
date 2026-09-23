import type { SessionRow } from "@agmux/protocol";

// The seam between UIs and the hub. Today: polling. When the comms milestone
// adds real streaming to the hub, an SSE-backed implementation replaces this
// without any UI change (polling stays as the reconnect fallback).
export interface SessionFeed {
  /**
   * Starts delivery; returns an unsubscribe function. onUpdate fires only when rows changed.
   * Call subscribe at most once per feed instance; create a new feed for a new subscription.
   */
  subscribe(onUpdate: (rows: SessionRow[]) => void, onError: (e: Error) => void): () => void;
}

// A hub URL, or a resolver called before every poll. The hub binds an ephemeral
// port and records it in the state dir, so `agmux hub restart` moves it — a feed
// holding a fixed URL then polls a dead port forever, reporting "hub down" while
// the hub is in fact up. Pass a resolver (the CLI re-reads hub.port) so a feed
// outlives a hub restart; a plain string stays fine for tests and fixed URLs.
export type HubUrlSource = string | (() => string | null | undefined);

export interface PollingFeedOpts {
  hubUrl: HubUrlSource;
  query: URLSearchParams;     // built by the caller (cli: buildLsQuery)
  intervalMs?: number;        // default 1000
  // Injection points for tests.
  fetchImpl?: typeof fetch;
  setIntervalImpl?: typeof setInterval;
  clearIntervalImpl?: typeof clearInterval;
}

export class PollingSessionFeed implements SessionFeed {
  constructor(private readonly o: PollingFeedOpts) {}

  subscribe(onUpdate: (rows: SessionRow[]) => void, onError: (e: Error) => void): () => void {
    const fetchImpl = this.o.fetchImpl ?? fetch;
    const src = this.o.hubUrl;
    const resolve = (): string | null | undefined => (typeof src === "function" ? src() : src);
    let inFlight = false;
    let stopped = false;
    let lastKey = "";

    const tick = async (): Promise<void> => {
      if (inFlight || stopped) return;
      inFlight = true;
      try {
        // Resolved per poll, not once per subscription: that is what lets a
        // long-lived dash or notifyd follow the hub across a restart.
        const base = resolve();
        if (!base) throw new Error("hub down");
        const r = await fetchImpl(`${base}/sessions?${this.o.query.toString()}`);
        if (!r.ok) throw new Error(`hub error ${r.status}`);
        const { sessions } = (await r.json()) as { sessions: SessionRow[] };
        const key = JSON.stringify(sessions);
        if (!stopped && key !== lastKey) {
          lastKey = key;
          onUpdate(sessions);
        }
      } catch (e) {
        if (!stopped) onError(e instanceof Error ? e : new Error(String(e)));
      } finally {
        inFlight = false;
      }
    };

    const timer = (this.o.setIntervalImpl ?? setInterval)(tick, this.o.intervalMs ?? 1000);
    void tick(); // immediate first poll — don't make the user wait one interval
    return () => {
      stopped = true;
      (this.o.clearIntervalImpl ?? clearInterval)(timer);
    };
  }
}
