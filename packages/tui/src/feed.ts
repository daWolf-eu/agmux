import type { SessionRow } from "@agmux/protocol";

// The seam between UIs and the hub. Today: polling. When the comms milestone
// adds real streaming to the hub, an SSE-backed implementation replaces this
// without any UI change (polling stays as the reconnect fallback).
export interface SessionFeed {
  /** Starts delivery; returns an unsubscribe function. onUpdate fires only when rows changed. */
  subscribe(onUpdate: (rows: SessionRow[]) => void, onError: (e: Error) => void): () => void;
}

export interface PollingFeedOpts {
  hubUrl: string;
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
    const url = `${this.o.hubUrl}/sessions?${this.o.query.toString()}`;
    let inFlight = false;
    let stopped = false;
    let lastKey = "";

    const tick = async (): Promise<void> => {
      if (inFlight || stopped) return;
      inFlight = true;
      try {
        const r = await fetchImpl(url);
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
