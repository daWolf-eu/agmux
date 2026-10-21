import { describe, expect, test } from "bun:test";
import { transportArgv } from "@agmux/hub";
import { runRemoteClient, tagFor, type RemoteClientDeps } from "../src/remote-client.ts";
import { fullScriptArgv, reapScriptArgv, viewScriptArgv, viewSessionName } from "../src/remote-tmux.ts";

const ID = "11111111-2222-4333-8444-555555555555";
const COORDS = { session: "work", window: "@0", pane: "%0", socket: "/tmp/tmux-998/default" };
const SPEC = { kind: "openshell" as const, gateway: "g", target: "wi-1", bin: "/bin/os" };
const row = (o: Record<string, unknown> = {}) => ({ session_id: ID, remote: true, status: "idle", host: "g/wi-1", remote_tmux: COORDS, ...o });
const host = (o: Record<string, unknown> = {}) => ({ host: "g/wi-1", remote: "r", transport: SPEC, ...o });

function setup(o: { session?: unknown; hosts?: unknown[]; childExit?: number; get?: string | Error; env?: Record<string, string> } = {}) {
  const tmux: string[][] = [];
  const captures: string[][] = [];
  const spawned: string[][] = [];
  const handlers: Record<string, () => void> = {};
  const exits: number[] = [];
  const deps: RemoteClientDeps = {
    fetchImpl: (async (url: string) => {
      if (String(url).includes("/sessions/")) return Response.json({ session: o.session ?? row() });
      return Response.json({ hosts: o.hosts ?? [host()], remotes: [] });
    }) as unknown as typeof fetch,
    tmux: async (a) => { tmux.push(a); },
    capture: async (argv) => {
      captures.push(argv);
      if (argv.includes("get")) { if (o.get instanceof Error) throw o.get; return o.get ?? '{"phase":"Ready"}'; }
      return "";
    },
    spawnTty: (argv) => { spawned.push(argv); return { exited: Promise.resolve(o.childExit ?? 0) }; },
    onSignal: (sig, fn) => { handlers[sig] = fn; },
    exit: ((c: number) => { exits.push(c); }) as never,
    rand: () => "deadbeef",
  };
  const run = (mode: "view" | "full" = "view") => runRemoteClient(
    { sessionId: ID, mode, detachKey: "M-d", hubUrl: "http://hub", env: o.env ?? { TMUX_PANE: "%12", TMUX: "/tmp/tmux-501/default,1,0" } }, deps);
  return { deps, tmux, captures, spawned, handlers, exits, run };
}

describe("tagFor", () => {
  test("pane", () => expect(tagFor({ TMUX_PANE: "%12" }, () => "x")).toBe("p12"));
  test("none", () => expect(tagFor({}, () => "abcd1234")).toBe("tabcd1234"));
  test("bad pane", () => expect(tagFor({ TMUX_PANE: "12;x" }, () => "abcd1234")).toBe("tabcd1234"));
});

describe("runRemoteClient", () => {
  test("view mode", async () => {
    const t = setup();
    expect(await t.run()).toBe(0);
    expect(t.tmux).toEqual([
      ["-S", "/tmp/tmux-501/default", "set-option", "-p", "-t", "%12", "@agmux_session_id", ID],
      ["-S", "/tmp/tmux-501/default", "set-option", "-p", "-t", "%12", "@agmux_remote", "1"],
      ["-S", "/tmp/tmux-501/default", "set-option", "-p", "-t", "%12", "@agmux_attach_mode", "view"],
    ]);
    expect(t.spawned).toEqual([transportArgv(SPEC, viewScriptArgv(COORDS, viewSessionName(ID, "p12"), "M-d", "p12"), { tty: true })]);
    expect(t.captures.filter((c) => c.includes("--no-tty"))).toEqual([]);
  });
  test("full mode", async () => {
    const t = setup();
    expect(await t.run("full")).toBe(0);
    expect(t.spawned).toEqual([transportArgv(SPEC, fullScriptArgv(COORDS, "p12"), { tty: true })]);
  });
  test("non-zero transport exit is returned and reaps", async () => {
    const t = setup({ childExit: 3 });
    expect(await t.run()).toBe(3);
    expect(t.captures).toContainEqual(transportArgv(SPEC, reapScriptArgv("p12"), { tty: false }));
  });
  test("SIGHUP reaps then exits 129; SIGTERM 143", async () => {
    const t = setup();
    await t.run();
    t.captures.length = 0;
    t.handlers.SIGHUP!();
    await new Promise((r) => setTimeout(r, 10));
    expect(t.captures).toEqual([transportArgv(SPEC, reapScriptArgv("p12"), { tty: false })]);
    expect(t.exits).toEqual([129]);
    const u = setup();
    await u.run();
    u.handlers.SIGTERM!();
    await new Promise((r) => setTimeout(r, 10));
    expect(u.exits).toEqual([143]);
  });
  test("stopped sandbox is started first", async () => {
    const t = setup({ get: '{"phase":"Stopped"}' });
    await t.run();
    expect(t.captures[0]).toEqual(["/bin/os", "-g", "g", "sandbox", "get", "wi-1", "-o", "json"]);
    expect(t.captures[1]).toEqual(["/bin/os", "-g", "g", "sandbox", "start", "wi-1"]);
    expect(t.spawned).toHaveLength(1);
  });
  test("failing get still spawns", async () => {
    const t = setup({ get: new Error("boom") });
    expect(await t.run()).toBe(0);
    expect(t.spawned).toHaveLength(1);
  });
  test("no TMUX_PANE: random tag, no pane options", async () => {
    const t = setup({ env: {} });
    await t.run();
    expect(t.tmux).toEqual([]);
    expect(t.spawned[0]).toEqual(transportArgv(SPEC, viewScriptArgv(COORDS, viewSessionName(ID, "tdeadbeef"), "M-d", "tdeadbeef"), { tty: true }));
  });
  const refused: [string, Parameters<typeof setup>[0]][] = [
    ["not remote", { session: row({ remote: false }) }],
    ["not live", { session: row({ status: "closed" }) }],
    ["bad coords", { session: row({ remote_tmux: { ...COORDS, window: "x" } }) }],
    ["no host row", { hosts: [] }],
    ["null transport", { hosts: [host({ transport: null })] }],
  ];
  for (const [name, o] of refused) {
    test(`refuses: ${name}`, async () => {
      const t = setup(o);
      expect(await t.run()).toBe(1);
      expect(t.spawned).toEqual([]);
    });
  }
});
