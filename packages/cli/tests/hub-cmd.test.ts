import { test, expect } from "bun:test";
import { runHubCmd, type HubCmdDeps } from "../src/hub-cmd.ts";

function base(over: Partial<HubCmdDeps>): HubCmdDeps {
  return {
    stateDir: "/x", hubBin: "agmux-hub", selfVersion: "0.2.0-dev",
    out: () => {},
    readPid: () => null, readPort: () => null, isAlive: () => false,
    kill: () => {}, ensureHub: async () => "http://127.0.0.1:0",
    fetchImpl: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
    sleep: async () => {}, nowMs: () => 0, loadRemotes: () => [],
    ...over,
  };
}
function health(version: string): typeof fetch {
  return (async () => new Response(JSON.stringify({ ok: true, version }), { status: 200 })) as unknown as typeof fetch;
}

test("status: reports when no hub is running", async () => {
  const out: string[] = [];
  await runHubCmd(["status"], base({ out: (s) => out.push(s) }));
  const txt = out.join("\n");
  expect(txt).toContain("not running");
  expect(txt).toContain("0.2.0-dev");
});

test("status: running + matching version → no restart hint", async () => {
  const out: string[] = [];
  await runHubCmd(["status"], base({
    readPid: () => 111, readPort: () => 5000, isAlive: () => true,
    fetchImpl: health("0.2.0-dev"), out: (s) => out.push(s),
  }));
  const txt = out.join("\n");
  expect(txt).toContain("pid 111");
  expect(txt).toContain("version 0.2.0-dev");
  expect(txt).not.toContain("hub restart");
});

test("status: running stale version → restart hint", async () => {
  const out: string[] = [];
  await runHubCmd(["status"], base({
    readPid: () => 111, readPort: () => 5000, isAlive: () => true,
    fetchImpl: health("0.1.0"), out: (s) => out.push(s),
  }));
  const txt = out.join("\n");
  expect(txt).toContain("version 0.1.0");
  expect(txt).toContain("agmux hub restart");
});

test("restart: stops a live hub then starts the new one", async () => {
  const calls: any[] = [];
  let alive = true;
  await runHubCmd(["restart"], base({
    readPid: () => 111, readPort: () => 6000, isAlive: () => alive,
    kill: (pid, sig) => { calls.push(["kill", pid, sig]); if (sig === "SIGTERM") alive = false; },
    ensureHub: async () => { calls.push(["ensure"]); return "http://127.0.0.1:6000"; },
    fetchImpl: health("0.2.0-dev"),
  }));
  expect(calls).toContainEqual(["kill", 111, "SIGTERM"]);
  expect(calls).toContainEqual(["ensure"]);
});

test("restart: no live hub → just starts one (no kill)", async () => {
  const calls: any[] = [];
  await runHubCmd(["restart"], base({
    readPid: () => null, isAlive: () => false,
    kill: () => calls.push("kill"),
    ensureHub: async () => { calls.push("ensure"); return "http://127.0.0.1:0"; },
  }));
  expect(calls).toEqual(["ensure"]);
});

test("unknown subcommand returns exit 2 with usage", async () => {
  const out: string[] = [];
  const rc = await runHubCmd(["bogus"], base({ out: (s) => out.push(s) }));
  expect(rc).toBe(2);
  expect(out.join("\n")).toContain("usage: agmux hub");
});

// --- host sync lines ---
const NOW = Date.parse("2026-10-20T12:00:00Z");
function hostRow(over: Record<string, unknown>) {
  return {
    host: "gw/sb", remote: "sb1", transport: null, last_sync_ts: "2026-10-20T11:59:30Z", last_sync_ok: true,
    last_error: null, cursor: 42, db_id: "d", agmux_version: "0.2.0", replication: 1, rejected: 0, removed_ts: null,
    ...over,
  };
}
function withHosts(hosts: unknown[] | "fail", remotes?: unknown[]): typeof fetch {
  return (async (url: string) => {
    if (String(url).endsWith("/hosts")) {
      if (hosts === "fail") throw new Error("boom");
      return new Response(JSON.stringify(remotes ? { hosts, remotes } : { hosts }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true, version: "0.2.0-dev" }), { status: 200 });
  }) as unknown as typeof fetch;
}
async function statusOut(hosts: unknown[] | "fail", over: Partial<HubCmdDeps> & { remotes?: unknown[] } = {}): Promise<string[]> {
  const out: string[] = [];
  const { remotes, ...rest } = over;
  const code = await runHubCmd(["status"], base({
    readPid: () => 111, readPort: () => 5000, isAlive: () => true,
    fetchImpl: withHosts(hosts, remotes), out: (s) => out.push(s), nowMs: () => NOW, ...rest,
  }));
  expect(code).toBe(0);
  return out;
}

test("status: ok host line", async () => {
  const out = await statusOut([hostRow({})]);
  expect(out).toContain("remote sb1  gw/sb  ok  last sync 30s ago  agmux 0.2.0  cursor 42");
});

test("status: stale host with rejected and error; never-synced", async () => {
  const out = await statusOut([hostRow({ last_sync_ok: false, last_sync_ts: null, rejected: 3, last_error: "unreachable" })]);
  expect(out).toContain("remote sb1  gw/sb  stale  last sync never  agmux 0.2.0  cursor 42  rejected 3  error: unreachable");
});

test("status: removed host still shows its error", async () => {
  const out = await statusOut([hostRow({ removed_ts: "2026-10-20T11:00:00Z", last_sync_ok: false, last_error: "x" })]);
  const line = out.find((l) => l.startsWith("remote "))!;
  expect(line).toContain("  removed  ");
  expect(line).toContain("error: x");
});

test("status: old sync prints yesterday without ago; hostile text is sanitized", async () => {
  const out = await statusOut([hostRow({ last_sync_ts: "2026-10-19T09:00:00Z", agmux_version: "1\x1b[31m", last_error: "a\nb\u009bc", last_sync_ok: false })]);
  const line = out.find((l) => l.startsWith("remote "))!;
  expect(line).toContain("last sync yesterday  agmux 1 [31m");
  expect(line).toContain("error: a b c");
  expect(line).not.toMatch(/[\u0000-\u001f\u009b]/);
});

test("status: newer replication note", async () => {
  const out = await statusOut([hostRow({ replication: 2 })]);
  expect(out).toContain("note: gw/sb runs a newer replication format (2); update agmux");
});

test("status: /hosts failure or empty list prints no host lines", async () => {
  for (const h of ["fail", []] as const) {
    const out = await statusOut(h as unknown[] | "fail");
    expect(out.some((l) => l.startsWith("remote "))).toBe(false);
  }
});

test("status: one line per remote before the host lines, with discovery age and error", async () => {
  const out = await statusOut([hostRow({})], { remotes: [
    { name: "lab", gateway: "gw", last_discovery_ts: "2026-10-20T11:59:55Z", nodes: 1 },
    { name: "lab2", gateway: "gw2", last_discovery_ts: null, nodes: 0, last_discovery_error: "openshell: not found\x1b[2J" },
    { name: "lab3", gateway: "gw3", last_discovery_ts: "2026-10-20T11:59:55Z", nodes: 3 },
  ] });
  const i = out.indexOf("remote lab  gateway gw  1 sandbox  last discovery 5s ago");
  expect(i).toBeGreaterThan(-1);
  expect(out[i + 1]).toBe("remote lab2  gateway gw2  0 sandboxes  last discovery never  error: openshell: not found [2J");
  expect(out[i + 2]).toBe("remote lab3  gateway gw3  3 sandboxes  last discovery 5s ago");
  expect(out.findIndex((l) => l.startsWith("remote sb1  gw/sb"))).toBeGreaterThan(i + 2);
});

test("status: the hub's config error is printed once", async () => {
  const out = await statusOut([], { remotes: [{ config_error: "/c.toml: bad\nline" }], loadRemotes: () => { throw new Error("/c.toml: bad\nline"); } });
  expect(out.filter((l) => l.includes("remote sync disabled"))).toEqual(["remote sync disabled: /c.toml: bad line"]);
});

test("status: a config broken since the hub started is a note", async () => {
  const out = await statusOut([], { remotes: [], loadRemotes: () => { throw new Error("interval must be a number >= 0.1"); } });
  expect(out).toContain("note: [[remote]] config is invalid; 'agmux hub restart' would disable sync: interval must be a number >= 0.1");
});

test("status: a config error is printed even when no hub is running", async () => {
  const out: string[] = [];
  await runHubCmd(["status"], base({ out: (s) => out.push(s), loadRemotes: () => { throw new Error("/c.toml: Invalid TOML"); } }));
  expect(out).toContain("hub: not running");
  expect(out).toContain("remote sync disabled: /c.toml: Invalid TOML");
});
