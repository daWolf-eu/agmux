import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EXIT_ROTATE } from "@agmux/protocol";
import { parseEventsArgs, eventsCmd, drainCmd, isEventsProcess, KEEPALIVE_MS, FOLLOW_POLL_MS } from "../src/events-cmd.ts";

test("parse: --after is required and a non-negative integer", () => {
  expect(parseEventsArgs([]).kind).toBe("error");
  expect(parseEventsArgs(["--after", "-1"]).kind).toBe("error");
  expect(parseEventsArgs(["--after", "1.5"]).kind).toBe("error");
  expect(parseEventsArgs(["--after", "x"]).kind).toBe("error");
  expect(parseEventsArgs(["--after", "0"])).toEqual({ kind: "ok", follow: false, after: 0, consumer: null, limit: 500, maxDurationS: null });
});

test("parse: flags", () => {
  expect(parseEventsArgs(["--follow", "--after", "7", "--consumer", "mac.1_a-b", "--limit", "20"]))
    .toEqual({ kind: "ok", follow: true, after: 7, consumer: "mac.1_a-b", limit: 20, maxDurationS: null });
  expect(parseEventsArgs(["--after", "0", "--limit", "0"]).kind).toBe("error");
  expect(parseEventsArgs(["--after", "0", "--limit", "x"]).kind).toBe("error");
  expect(parseEventsArgs(["--after", "0", "--limit", "5001"]).kind).toBe("error");
  expect(parseEventsArgs(["--after", "0", "--limit", "5000"]).kind).toBe("ok");
  expect(parseEventsArgs(["--after", "0", "--consumer", "../x"]).kind).toBe("error");
  expect(parseEventsArgs(["--after", "0", "--consumer", "a".repeat(65)]).kind).toBe("error");
  expect(parseEventsArgs(["--after", "0", "--bogus"]).kind).toBe("error");
  expect(parseEventsArgs(["--after"]).kind).toBe("error");
});

test("parse: --max-duration is a positive integer and needs --follow", () => {
  expect(parseEventsArgs(["--max-duration", "3600", "--follow", "--after", "0"]))
    .toEqual({ kind: "ok", follow: true, after: 0, consumer: null, limit: 500, maxDurationS: 3600 });
  expect(parseEventsArgs(["--follow", "--after", "0", "--max-duration", "0"]).kind).toBe("error");
  expect(parseEventsArgs(["--follow", "--after", "0", "--max-duration", "-5"]).kind).toBe("error");
  expect(parseEventsArgs(["--follow", "--after", "0", "--max-duration", "1.5"]).kind).toBe("error");
  expect(parseEventsArgs(["--follow", "--after", "0", "--max-duration"]).kind).toBe("error");
  expect(parseEventsArgs(["--after", "0", "--max-duration", "60"]))
    .toEqual({ kind: "error", message: "events: --max-duration needs --follow" });
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

test("follow --max-duration exits EXIT_ROTATE at the next loop boundary, after the current page", async () => {
  // 3 pages of 2 rows; every events request takes 1 s on the fake clock.
  const hub = fakeHub(6);
  let now = 0;
  const fetchImpl = (async (u: any, i: any) => {
    if (String(u).includes("/events")) now += 1000;
    return hub.fetchImpl(u, i);
  }) as unknown as typeof fetch;
  const { deps, lines } = mkDeps({ fetchImpl, nowMs: () => now, sleep: async (ms: number) => { now += ms; } });
  const code = await eventsCmd({ hubUrl: "http://h", follow: true, after: 0, consumer: null, limit: 2, maxDurationS: 2 }, deps);
  expect(EXIT_ROTATE).toBe(75);
  expect(code).toBe(EXIT_ROTATE);
  // Deadline passes during the 2nd page: that page is written in full, then the command exits.
  expect(lines.slice(1).map((l) => JSON.parse(l).id)).toEqual([1, 2, 3, 4]);
  expect(hub.urls.filter((u) => u.includes("/events"))).toHaveLength(2);
});

test("follow --max-duration also ends an idle stream", async () => {
  const { deps, lines } = mkDeps({ fetchImpl: fakeHub(0).fetchImpl });
  const code = await eventsCmd({ hubUrl: "http://h", follow: true, after: 0, consumer: null, limit: 500, maxDurationS: 60 }, deps);
  expect(code).toBe(EXIT_ROTATE);
  // header + keepalives at 15, 30 and 45 s; at 60 s the deadline check comes first
  expect(lines.map((l) => Object.keys(JSON.parse(l))[0])).toEqual(["replication", "keepalive", "keepalive", "keepalive"]);
});

test("follow --max-duration: SIGTERM before the deadline still exits 0", async () => {
  const ac = new AbortController();
  const { deps } = mkDeps({ fetchImpl: fakeHub(0).fetchImpl });
  const tick = deps.sleep;
  deps.sleep = async (ms: number) => { await tick(ms); ac.abort(); };
  const code = await eventsCmd({ hubUrl: "http://h", follow: true, after: 0, consumer: null, limit: 500, maxDurationS: 60, signal: ac.signal }, deps);
  expect(code).toBe(0);
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
    isFollower: (pid: number) => pid === 4242,
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

test("consumer lock: a live pid that is not an `agmux events` process (pid reuse) is not signalled", async () => {
  const kills: number[] = [];
  const { deps, stateDir } = mkDeps({
    fetchImpl: fakeHub(0).fetchImpl,
    kill: (pid: number) => { kills.push(pid); },
    isAlive: () => true, isFollower: () => false, pid: 99,
  });
  fs.mkdirSync(path.join(stateDir, "follow"));
  const pidFile = path.join(stateDir, "follow", "c.pid");
  fs.writeFileSync(pidFile, "123\n");
  let during = "";
  const write = deps.write;
  deps.write = (l: string) => { during = fs.readFileSync(pidFile, "utf8").trim(); return write(l); };
  await eventsCmd({ hubUrl: "http://h", follow: false, after: 0, consumer: "c", limit: 500 }, deps);
  expect(kills).toEqual([]);
  expect(during).toBe("99");
});

test("isEventsProcess: /proc cmdline must have an `events` argument; unreadable = not ours", () => {
  const files: Record<string, string> = {
    "/proc/1/cmdline": "/usr/local/bin/agmux\0events\0--follow\0--after\0" + "0\0",
    "/proc/2/cmdline": "/usr/bin/python3\0/home/events/x.py\0",
  };
  const read = (f: string) => { const v = files[f]; if (v === undefined) throw new Error("ENOENT"); return v; };
  expect(isEventsProcess(1, { platform: "linux", readFile: read })).toBe(true);
  expect(isEventsProcess(2, { platform: "linux", readFile: read })).toBe(false);
  expect(isEventsProcess(3, { platform: "linux", readFile: read })).toBe(false);
  expect(isEventsProcess(4, { platform: "darwin", ps: () => "/opt/bin/agmux events --follow --after 0" })).toBe(true);
  expect(isEventsProcess(5, { platform: "darwin", ps: () => { throw new Error("no such pid"); } })).toBe(false);
});

test("consumer start writes <c>.after atomically next to <c>.pid", async () => {
  const { deps, stateDir } = mkDeps({ fetchImpl: fakeHub(0).fetchImpl, isAlive: () => false, pid: 99 });
  let during = "";
  const write = deps.write;
  deps.write = (l: string) => { during = fs.readFileSync(path.join(stateDir, "follow", "mac.after"), "utf8"); return write(l); };
  await eventsCmd({ hubUrl: "http://h", follow: false, after: 42, consumer: "mac", limit: 500 }, deps);
  expect(during).toBe("42\n");
  expect(fs.readdirSync(path.join(stateDir, "follow")).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  const none = mkDeps({ fetchImpl: fakeHub(0).fetchImpl });
  await eventsCmd({ hubUrl: "http://h", follow: false, after: 5, consumer: null, limit: 500 }, none.deps);
  expect(fs.existsSync(path.join(none.stateDir, "follow"))).toBe(false);
});

test("parse: --drain", () => {
  expect(parseEventsArgs(["--drain"])).toEqual({ kind: "drain", timeoutS: 60 });
  expect(parseEventsArgs(["--drain", "--timeout", "5"])).toEqual({ kind: "drain", timeoutS: 5 });
  expect(parseEventsArgs(["--drain", "--follow"]).kind).toBe("error");
  expect(parseEventsArgs(["--drain", "--after", "0"]).kind).toBe("error");
  expect(parseEventsArgs(["--drain", "--timeout", "0"]).kind).toBe("error");
  expect(parseEventsArgs(["--drain", "--timeout", "x"]).kind).toBe("error");
  expect(parseEventsArgs(["--after", "0", "--timeout", "5"]).kind).toBe("error");
});

// Drain harness: a hub with the given head, a follow dir, a fake clock that advances on sleep.
function drainEnv(head: number, over: Record<string, unknown> = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "agmux-drain-"));
  const dir = path.join(stateDir, "follow");
  fs.mkdirSync(dir);
  const errs: string[] = [];
  const kills: Array<[number, string]> = [];
  let now = Date.now();
  const deps = {
    fetchImpl: (async (u: any) => {
      expect(String(u)).toBe("http://h/events/head");
      return Response.json({ id: head });
    }) as unknown as typeof fetch,
    sleep: async (ms: number) => { now += ms; },
    nowMs: () => now,
    stateDir,
    err: (l: string) => { errs.push(l); },
    kill: (pid: number, sig: string) => { kills.push([pid, sig]); },
    isAlive: (pid: number) => pid === 4242,
    isFollower: () => true,
    ...over,
  };
  const consumer = (name: string, o: { pid?: number; after?: number; ageS?: number }) => {
    if (o.pid !== undefined) fs.writeFileSync(path.join(dir, `${name}.pid`), `${o.pid}\n`);
    if (o.after !== undefined) {
      const f = path.join(dir, `${name}.after`);
      fs.writeFileSync(f, `${o.after}\n`);
      const t = (now - (o.ageS ?? 0) * 1000) / 1000;
      fs.utimesSync(f, t, t);
    }
  };
  return { deps: deps as any, errs, kills, dir, consumer, now: () => now };
}

test("drain: SIGTERMs the live follower and exits 0 once its reconnect writes .after = head", async () => {
  const env = drainEnv(10);
  env.consumer("mac", { pid: 4242, after: 7 });
  let sleeps = 0;
  const tick = env.deps.sleep;
  env.deps.sleep = async (ms: number) => {
    await tick(ms);
    if (++sleeps === 2) env.consumer("mac", { after: 10 }); // the Mac reconnected with its cursor
  };
  expect(await drainCmd({ hubUrl: "http://h", timeoutS: 60 }, env.deps)).toBe(0);
  expect(env.kills).toEqual([[4242, "SIGTERM"]]);
  expect(env.errs).toEqual([]);
});

test("drain: no consumer exits 3", async () => {
  const env = drainEnv(10);
  expect(await drainCmd({ hubUrl: "http://h", timeoutS: 60 }, env.deps)).toBe(3);
  expect(env.errs).toEqual(["agmux events --drain: no replication consumer"]);
  const noDir = drainEnv(10);
  fs.rmSync(noDir.dir, { recursive: true });
  expect(await drainCmd({ hubUrl: "http://h", timeoutS: 60 }, noDir.deps)).toBe(3);
});

test("drain: a consumer that never reconnects times out with exit 1, naming it, head and .after", async () => {
  const env = drainEnv(10);
  env.consumer("mac", { pid: 4242, after: 7 });
  const t0 = env.now();
  expect(await drainCmd({ hubUrl: "http://h", timeoutS: 5 }, env.deps)).toBe(1);
  expect(env.now() - t0).toBeGreaterThanOrEqual(5000);
  expect(env.errs).toHaveLength(1);
  expect(env.errs[0]).toContain("head 10");
  expect(env.errs[0]).toContain("mac (after 7)");
});

test("drain: a stale consumer (dead pid, old .after) is ignored; a recent dead-pid one still counts", async () => {
  const stale = drainEnv(10);
  stale.consumer("old", { pid: 1, after: 0, ageS: 301 });
  expect(await drainCmd({ hubUrl: "http://h", timeoutS: 5 }, stale.deps)).toBe(3);

  const mixed = drainEnv(10);
  mixed.consumer("old", { pid: 1, after: 0, ageS: 3600 });
  mixed.consumer("mac", { after: 10, ageS: 10 });
  expect(await drainCmd({ hubUrl: "http://h", timeoutS: 5 }, mixed.deps)).toBe(0);
  expect(mixed.kills).toEqual([]);

  const lag = drainEnv(10);
  lag.consumer("mac", { after: 3, ageS: 10 });
  expect(await drainCmd({ hubUrl: "http://h", timeoutS: 1 }, lag.deps)).toBe(1);
  expect(lag.errs[0]).toContain("mac (after 3)");
});

test("drain: a live pid that is not an agmux events process (pid reuse) is neither signalled nor counted", async () => {
  const env = drainEnv(10, { isFollower: () => false });
  env.consumer("mac", { pid: 4242, after: 0, ageS: 9999 });
  expect(await drainCmd({ hubUrl: "http://h", timeoutS: 5 }, env.deps)).toBe(3);
  expect(env.kills).toEqual([]);
});

test("drain: unreachable hub exits 1", async () => {
  const env = drainEnv(10, { fetchImpl: (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch });
  env.consumer("mac", { pid: 4242, after: 10 });
  expect(await drainCmd({ hubUrl: "http://h", timeoutS: 5 }, env.deps)).toBe(1);
  expect(env.kills).toEqual([]);
});
