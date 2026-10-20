import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseEventsArgs, eventsCmd, KEEPALIVE_MS, FOLLOW_POLL_MS } from "../src/events-cmd.ts";

test("parse: --after is required and a non-negative integer", () => {
  expect(parseEventsArgs([]).kind).toBe("error");
  expect(parseEventsArgs(["--after", "-1"]).kind).toBe("error");
  expect(parseEventsArgs(["--after", "1.5"]).kind).toBe("error");
  expect(parseEventsArgs(["--after", "x"]).kind).toBe("error");
  expect(parseEventsArgs(["--after", "0"])).toEqual({ kind: "ok", follow: false, after: 0, consumer: null, limit: 500 });
});

test("parse: flags", () => {
  expect(parseEventsArgs(["--follow", "--after", "7", "--consumer", "mac.1_a-b", "--limit", "20"]))
    .toEqual({ kind: "ok", follow: true, after: 7, consumer: "mac.1_a-b", limit: 20 });
  expect(parseEventsArgs(["--after", "0", "--limit", "0"]).kind).toBe("error");
  expect(parseEventsArgs(["--after", "0", "--limit", "x"]).kind).toBe("error");
  expect(parseEventsArgs(["--after", "0", "--limit", "5001"]).kind).toBe("error");
  expect(parseEventsArgs(["--after", "0", "--limit", "5000"]).kind).toBe("ok");
  expect(parseEventsArgs(["--after", "0", "--consumer", "../x"]).kind).toBe("error");
  expect(parseEventsArgs(["--after", "0", "--consumer", "a".repeat(65)]).kind).toBe("error");
  expect(parseEventsArgs(["--after", "0", "--bogus"]).kind).toBe("error");
  expect(parseEventsArgs(["--after"]).kind).toBe("error");
});

const ev = (n: number) => ({ id: `e${n}`, kind: "x" });
// Fake hub holding rows 1..total; pages by after_id/limit. Optional hook per events request.
function fakeHub(total: number, onEvents?: (n: number) => void) {
  const urls: string[] = [];
  let calls = 0;
  const fetchImpl = (async (u: any) => {
    urls.push(String(u));
    const url = new URL(String(u));
    if (url.pathname === "/health") return Response.json({ ok: true, version: "v", db_id: "db-1" });
    calls++;
    onEvents?.(calls);
    const after = Number(url.searchParams.get("after_id"));
    const limit = Number(url.searchParams.get("limit"));
    const records = [];
    for (let i = after + 1; i <= Math.min(total, after + limit); i++) records.push({ id: i, ev: ev(i) });
    return Response.json({ records, last_id: records.length ? records[records.length - 1]!.id : after });
  }) as unknown as typeof fetch;
  return { fetchImpl, urls };
}

function mkDeps(over: Record<string, unknown> = {}) {
  const lines: string[] = [];
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "agmux-events-"));
  let now = 1_000_000;
  const deps = {
    fetchImpl: fakeHub(0).fetchImpl,
    write: (l: string) => { lines.push(l); return true; },
    sleep: async (ms: number) => { now += ms; },
    nowMs: () => now,
    host: "box", stateDir,
    ...over,
  };
  return { deps: deps as any, lines, stateDir };
}

test("one-shot drains pages until a short page", async () => {
  const hub = fakeHub(1007);
  const { deps, lines } = mkDeps({ fetchImpl: hub.fetchImpl });
  const code = await eventsCmd({ hubUrl: "http://h", follow: false, after: 0, consumer: null, limit: 500 }, deps);
  expect(code).toBe(0);
  expect(lines.length).toBe(1 + 1007);
  expect(JSON.parse(lines[0]!)).toEqual({ replication: 1, agmux: expect.any(String), db_id: "db-1", host: "box" });
  expect(JSON.parse(lines[1]!)).toEqual({ id: 1, ev: ev(1) });
  expect(JSON.parse(lines[1007]!).id).toBe(1007);
  const evUrls = hub.urls.filter((u) => u.includes("/events"));
  expect(evUrls.map((u) => new URL(u).searchParams.get("after_id"))).toEqual(["0", "500", "1000"]);
  expect(evUrls.every((u) => new URL(u).searchParams.get("limit") === "500")).toBe(true);
});

test("follow emits a keepalive after silence, not before", async () => {
  const { deps, lines } = mkDeps({ fetchImpl: fakeHub(0).fetchImpl });
  const ac = new AbortController();
  let slept = 0;
  const tick = deps.sleep;
  deps.sleep = async (ms: number) => {
    await tick(ms);
    slept += ms;
    if (slept > KEEPALIVE_MS + FOLLOW_POLL_MS) ac.abort();
  };
  const code = await eventsCmd({ hubUrl: "http://h", follow: true, after: 0, consumer: null, limit: 500, signal: ac.signal }, deps);
  expect(code).toBe(0);
  const parsed = lines.map((l) => JSON.parse(l));
  expect(parsed.length).toBe(2); // header + exactly one keepalive
  expect(typeof parsed[1].keepalive).toBe("string");
  expect(new Date(parsed[1].keepalive).toISOString()).toBe(parsed[1].keepalive);
});

test("follow picks up rows appearing after an empty page", async () => {
  let total = 0;
  const urls: string[] = [];
  const fetchImpl = (async (u: any) => {
    const url = new URL(String(u));
    if (url.pathname === "/health") return Response.json({ db_id: "d" });
    urls.push(String(u));
    const after = Number(url.searchParams.get("after_id"));
    if (urls.length === 2) total = 2;
    const records = [];
    for (let i = after + 1; i <= total; i++) records.push({ id: i, ev: ev(i) });
    return Response.json({ records, last_id: records.length ? total : after });
  }) as unknown as typeof fetch;
  const ac = new AbortController();
  const { deps, lines } = mkDeps({ fetchImpl });
  deps.sleep = async () => { if (urls.length >= 3) ac.abort(); };
  await eventsCmd({ hubUrl: "http://h", follow: true, after: 0, consumer: null, limit: 500, signal: ac.signal }, deps);
  expect(lines.slice(1).map((l) => JSON.parse(l).id)).toEqual([1, 2]);
});

test("exits 0 when write returns false", async () => {
  const { deps } = mkDeps({ fetchImpl: fakeHub(5).fetchImpl, write: () => false });
  expect(await eventsCmd({ hubUrl: "http://h", follow: true, after: 0, consumer: null, limit: 500 }, deps)).toBe(0);
});

test("exits 0 when write throws EPIPE", async () => {
  const { deps } = mkDeps({
    fetchImpl: fakeHub(5).fetchImpl,
    write: () => { throw Object.assign(new Error("broken pipe"), { code: "EPIPE" }); },
  });
  expect(await eventsCmd({ hubUrl: "http://h", follow: true, after: 0, consumer: null, limit: 500 }, deps)).toBe(0);
});

test("hub unreachable mid-follow exits 1", async () => {
  let n = 0;
  const base = fakeHub(0).fetchImpl;
  const fetchImpl = (async (u: any, i: any) => {
    if (String(u).includes("/events") && ++n >= 2) throw new Error("ECONNREFUSED");
    return base(u, i);
  }) as unknown as typeof fetch;
  const { deps } = mkDeps({ fetchImpl });
  expect(await eventsCmd({ hubUrl: "http://h", follow: true, after: 0, consumer: null, limit: 500 }, deps)).toBe(1);
});

test("consumer lock replaces a live previous follower and cleans up on exit", async () => {
  const kills: Array<[number, string]> = [];
  const { deps, stateDir } = mkDeps({
    fetchImpl: fakeHub(1).fetchImpl,
    kill: (pid: number, sig: string) => { kills.push([pid, sig]); },
    isAlive: (pid: number) => pid === 4242,
    pid: 99,
  });
  fs.mkdirSync(path.join(stateDir, "follow"));
  const pidFile = path.join(stateDir, "follow", "mac.pid");
  fs.writeFileSync(pidFile, "4242\n");
  let during = "";
  const write = deps.write;
  deps.write = (l: string) => { during = fs.readFileSync(pidFile, "utf8").trim(); return write(l); };
  await eventsCmd({ hubUrl: "http://h", follow: false, after: 0, consumer: "mac", limit: 500 }, deps);
  expect(kills).toEqual([[4242, "SIGTERM"]]);
  expect(during).toBe("99");
  expect(fs.existsSync(pidFile)).toBe(false);
});

test("consumer lock: stale pid is overwritten without a kill; dir is created", async () => {
  const kills: number[] = [];
  const { deps, stateDir } = mkDeps({
    fetchImpl: fakeHub(0).fetchImpl,
    kill: (pid: number) => { kills.push(pid); },
    isAlive: () => false, pid: 99,
  });
  fs.mkdirSync(path.join(stateDir, "follow"));
  fs.writeFileSync(path.join(stateDir, "follow", "c.pid"), "123");
  await eventsCmd({ hubUrl: "http://h", follow: false, after: 0, consumer: "c", limit: 500 }, deps);
  expect(kills).toEqual([]);

  const fresh = mkDeps({ fetchImpl: fakeHub(0).fetchImpl, kill: () => {}, isAlive: () => false });
  await eventsCmd({ hubUrl: "http://h", follow: false, after: 0, consumer: "c", limit: 500 }, fresh.deps);
  expect(fs.existsSync(path.join(fresh.stateDir, "follow"))).toBe(true);
});
