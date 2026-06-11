import { test, expect } from "bun:test";
import { PollingSessionFeed } from "../src/feed.ts";

type Tick = () => Promise<void> | void;

function harness(responses: Array<() => Promise<Response>>) {
  let call = 0;
  const urls: string[] = [];
  const fetchImpl = ((url: string) => {
    urls.push(String(url));
    const r = responses[Math.min(call, responses.length - 1)]!;
    call++;
    return r();
  }) as unknown as typeof fetch;

  let tick: Tick = () => {};
  let cleared = false;
  const setIntervalImpl = ((fn: Tick) => { tick = fn; return 1 as any; }) as typeof setInterval;
  const clearIntervalImpl = ((_: any) => { cleared = true; }) as typeof clearInterval;

  const feed = new PollingSessionFeed({
    hubUrl: "http://127.0.0.1:9999",
    query: new URLSearchParams({ status: "open" }),
    fetchImpl, setIntervalImpl, clearIntervalImpl,
  });
  return { feed, urls, tickRef: () => tick, wasCleared: () => cleared };
}

const rowsA = [{ session_id: "a" }];
const rowsB = [{ session_id: "b" }];
const ok = (rows: unknown) => () => Promise.resolve(Response.json({ sessions: rows }));

test("first poll fires immediately and delivers rows; query lands in the URL", async () => {
  const h = harness([ok(rowsA)]);
  const updates: unknown[] = [];
  h.feed.subscribe((r) => updates.push(r), () => { throw new Error("unexpected error"); });
  await Bun.sleep(0); // drain the immediate first poll
  expect(updates).toEqual([rowsA]);
  expect(h.urls[0]).toBe("http://127.0.0.1:9999/sessions?status=open");
});

test("unchanged rows are suppressed; changed rows fire onUpdate", async () => {
  const h = harness([ok(rowsA), ok(rowsA), ok(rowsB)]);
  const updates: unknown[] = [];
  h.feed.subscribe((r) => updates.push(r), () => {});
  await Bun.sleep(0);
  await h.tickRef()(); // same rows → suppressed
  await h.tickRef()(); // changed → fires
  expect(updates).toEqual([rowsA, rowsB]);
});

test("non-ok and thrown fetches surface via onError and polling continues", async () => {
  const h = harness([
    () => Promise.resolve(new Response("nope", { status: 500 })),
    () => Promise.reject(new Error("ECONNREFUSED")),
    ok(rowsA),
  ]);
  const updates: unknown[] = [];
  const errors: string[] = [];
  h.feed.subscribe((r) => updates.push(r), (e) => errors.push(e.message));
  await Bun.sleep(0);
  await h.tickRef()();
  await h.tickRef()();
  expect(errors).toEqual(["hub error 500", "ECONNREFUSED"]);
  expect(updates).toEqual([rowsA]);
});

test("in-flight guard: a tick during a pending fetch is skipped", async () => {
  let release!: (r: Response) => void;
  const gated = new Promise<Response>((res) => { release = res; });
  const h = harness([() => gated, ok(rowsB)]);
  const updates: unknown[] = [];
  h.feed.subscribe((r) => updates.push(r), () => {});
  await h.tickRef()(); // skipped: first (immediate) poll still pending
  release(Response.json({ sessions: rowsA }));
  await Bun.sleep(0);
  expect(updates).toEqual([rowsA]); // the gated overlap tick fetched nothing
});

test("unsubscribe clears the interval and silences late results", async () => {
  let release!: (r: Response) => void;
  const gated = new Promise<Response>((res) => { release = res; });
  const h = harness([() => gated]);
  const updates: unknown[] = [];
  const stop = h.feed.subscribe((r) => updates.push(r), () => {});
  stop();
  expect(h.wasCleared()).toBe(true);
  release(Response.json({ sessions: rowsA }));
  await Bun.sleep(0);
  expect(updates).toEqual([]); // in-flight result after stop is dropped
});

test("unsubscribe silences a late rejection too", async () => {
  let reject!: (e: Error) => void;
  const gated = new Promise<Response>((_res, rej) => { reject = rej; });
  const h = harness([() => gated]);
  const errors: string[] = [];
  const stop = h.feed.subscribe(() => {}, (e) => errors.push(e.message));
  stop();
  reject(new Error("late ECONNREFUSED"));
  await Bun.sleep(0);
  expect(errors).toEqual([]);
});
