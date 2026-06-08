import { test, expect } from "bun:test";
import { runHubCmd, type HubCmdDeps } from "../src/hub-cmd.ts";

function base(over: Partial<HubCmdDeps>): HubCmdDeps {
  return {
    stateDir: "/x", hubBin: "agmux-hub", selfVersion: "0.2.0-dev",
    out: () => {},
    readPid: () => null, readPort: () => null, isAlive: () => false,
    kill: () => {}, ensureHub: async () => "http://127.0.0.1:0",
    fetchImpl: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
    sleep: async () => {}, nowMs: () => 0,
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
