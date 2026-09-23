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

// --- following the hub across a restart --------------------------------------
// The hub binds an ephemeral port recorded in the state dir, so `agmux hub
// restart` moves it. A feed that resolved its URL once at subscribe time then
// polled the dead port forever — silently, because "hub down" is a normal render
// state. That is what left a dash frozen on days-old rows and a tmux status line
// reading "hub down" seconds after a successful restart.
function resolverHarness(
  resolve: () => string | null | undefined,
  responses: Array<(url: string) => Promise<Response>>,
) {
  let call = 0;
  const urls: string[] = [];
  const fetchImpl = ((url: string) => {
    urls.push(String(url));
    const r = responses[Math.min(call, responses.length - 1)]!;
    call++;
    return r(String(url));
  }) as unknown as typeof fetch;

  let tick: Tick = () => {};
  const setIntervalImpl = ((fn: Tick) => { tick = fn; return 1 as any; }) as typeof setInterval;
  const clearIntervalImpl = ((_: any) => {}) as typeof clearInterval;

  const feed = new PollingSessionFeed({
    hubUrl: resolve,
    query: new URLSearchParams({ status: "open" }),
    fetchImpl, setIntervalImpl, clearIntervalImpl,
  });
  return { feed, urls, tickRef: () => tick };
}

test("a resolver is consulted on every poll, not once per subscription", async () => {
  let port = 1111;
  const h = resolverHarness(() => `http://127.0.0.1:${port}`, [ok(rowsA)]);
  h.feed.subscribe(() => {}, () => {});
  await Bun.sleep(0);

  // The hub restarts onto a new port mid-subscription.
  port = 2222;
  await h.tickRef()();
  await h.tickRef()();

  expect(h.urls[0]).toBe("http://127.0.0.1:1111/sessions?status=open");
  expect(h.urls.at(-1)).toBe("http://127.0.0.1:2222/sessions?status=open");
});

test("a feed recovers on its own once the hub comes back on a new port", async () => {
  let url: string | null = "http://127.0.0.1:1111";
  const h = resolverHarness(
    () => url,
    [
      // Old port: connection refused, as after a hub restart.
      (u) => u.includes("1111") ? Promise.reject(new Error("ECONNREFUSED")) : Promise.resolve(Response.json({ sessions: rowsA })),
    ],
  );
  const updates: unknown[] = [];
  const errors: Error[] = [];
  h.feed.subscribe((r) => updates.push(r), (e) => errors.push(e));
  await Bun.sleep(0);
  expect(errors.length).toBe(1);
  expect(updates).toEqual([]);

  // The hub is back; the port file now names the new port.
  url = "http://127.0.0.1:2222";
  await h.tickRef()();
  expect(updates).toEqual([rowsA]);
});

test("no resolvable hub reports an error rather than fetching a junk URL", async () => {
  const h = resolverHarness(() => null, [ok(rowsA)]);
  const errors: Error[] = [];
  h.feed.subscribe(() => { throw new Error("unexpected update"); }, (e) => errors.push(e));
  await Bun.sleep(0);
  expect(errors.map((e) => e.message)).toEqual(["hub down"]);
  expect(h.urls).toEqual([]);
});

test("a plain string hubUrl still works", async () => {
  const h = harness([ok(rowsA)]);
  const updates: unknown[] = [];
  h.feed.subscribe((r) => updates.push(r), () => {});
  await Bun.sleep(0);
  expect(updates).toEqual([rowsA]);
});
