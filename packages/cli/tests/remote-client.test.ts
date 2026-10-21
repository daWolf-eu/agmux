import { describe, expect, test } from "bun:test";
import { transportArgv } from "@agmux/hub";
import { runRemoteClient, tagFor, type RemoteClientDeps } from "../src/remote-client.ts";
import { fullScriptArgv, reapScriptArgv, viewScriptArgv, viewSessionName } from "../src/remote-tmux.ts";

const ID = "11111111-2222-4333-8444-555555555555";
const COORDS = { session: "work", window: "@0", pane: "%0", socket: "/tmp/tmux-998/default" };
const SPEC = { kind: "openshell" as const, gateway: "g", target: "wi-1", bin: "/bin/os" };
const row = (o: Record<string, unknown> = {}) => ({ session_id: ID, remote: true, status: "idle", host: "g/wi-1", remote_tmux: COORDS, ...o });
const host = (o: Record<string, unknown> = {}) => ({ host: "g/wi-1", remote: "r", transport: SPEC, ...o });

function setup(o: { session?: unknown; hosts?: unknown[]; childExit?: number; get?: string | Error; pendingExit?: Promise<number>; reapGate?: Promise<void>; sid?: string; env?: Record<string, string> } = {}) {
  const tmux: string[][] = [];
  const captures: string[][] = [];
  const spawned: string[][] = [];
  const handlers: Record<string, () => void> = {};
  const exits: number[] = [];
  const kills: string[] = [];
  // tmux calls and the reap, in call order.
  const events: string[] = [];
  const deps: RemoteClientDeps = {
    fetchImpl: (async (url: string) => {
      if (String(url).includes("/sessions/")) return Response.json({ session: o.session ?? row() });
      return Response.json({ hosts: o.hosts ?? [host()], remotes: [] });
    }) as unknown as typeof fetch,
    tmux: async (a) => { tmux.push(a); events.push(`tmux ${a.slice(2, 4).join(" ")} ${a.at(-1)}`); },
    capture: async (argv) => {
      captures.push(argv);
      if (argv.includes("--no-tty")) events.push("reap");
      if (argv.includes("get")) { if (o.get instanceof Error) throw o.get; return o.get ?? '{"phase":"Ready"}'; }
      if (o.reapGate && argv.includes("--no-tty")) await o.reapGate;
      return "";
    },
    spawnTty: (argv) => {
      spawned.push(argv);
      return { exited: o.pendingExit ?? Promise.resolve(o.childExit ?? 0), kill: (sig) => { kills.push(sig); events.push(`kill ${sig}`); } };
    },
    onSignal: (sig, fn) => { handlers[sig] = fn; },
    exit: ((c: number) => { exits.push(c); }) as never,
    rand: () => "deadbeef",
  };
  const run = (mode: "view" | "full" = "view") => runRemoteClient(
    { sessionId: ID, mode, detachKey: "M-d", hubUrl: "http://hub", env: o.env ?? { TMUX_PANE: "%12", TMUX: "/tmp/tmux-501/default,1,0" } }, deps);
  return { deps, tmux, captures, spawned, handlers, exits, kills, events, run };
}

describe("tagFor", () => {
  test("pane", () => expect(tagFor({ TMUX_PANE: "%12" }, () => "x")).toBe("p12"));
  test("none", () => expect(tagFor({}, () => "abcd1234")).toBe("tabcd1234"));
  test("bad pane", () => expect(tagFor({ TMUX_PANE: "12;x" }, () => "abcd1234")).toBe("tabcd1234"));
});

const SOCK = ["-S", "/tmp/tmux-501/default"];
const SET = [
  [...SOCK, "set-option", "-p", "-t", "%12", "@agmux_session_id", ID],
  [...SOCK, "set-option", "-p", "-t", "%12", "@agmux_remote", "1"],
  [...SOCK, "set-option", "-p", "-t", "%12", "@agmux_attach_mode", "view"],
];
const UNSET = ["@agmux_session_id", "@agmux_remote", "@agmux_attach_mode"].map((k) => [...SOCK, "set-option", "-p", "-u", "-t", "%12", k]);
const UNSET_EVENTS = ["@agmux_session_id", "@agmux_remote", "@agmux_attach_mode"].map((k) => `tmux set-option -p ${k}`);

describe("runRemoteClient", () => {
  test("view mode", async () => {
    const t = setup();
    expect(await t.run()).toBe(0);
    expect(t.tmux).toEqual([...SET, ...UNSET]);
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
  test("exit 0: pane options are unset before returning", async () => {
    const t = setup();
    expect(await t.run()).toBe(0);
    expect(t.tmux.slice(3)).toEqual(UNSET);
  });
  test("exit 3: pane options are unset before the reap (and the hold)", async () => {
    const t = setup({ childExit: 3 });
    expect(await t.run()).toBe(3);
    expect(t.tmux.slice(3)).toEqual(UNSET);
    expect(t.events.slice(3)).toEqual([...UNSET_EVENTS, "reap"]);
  });
  test("a failing unset is ignored", async () => {
    const t = setup({ childExit: 3 });
    t.deps.tmux = async (a) => { t.tmux.push(a); if (a.includes("-u")) throw new Error("no pane"); };
    expect(await t.run()).toBe(3);
    expect(t.tmux.slice(3)).toEqual(UNSET);
    expect(t.captures).toContainEqual(transportArgv(SPEC, reapScriptArgv("p12"), { tty: false }));
  });
  test("signal: unsets the pane options, hangs up the child, reaps, then exits", async () => {
    let endChild!: (n: number) => void;
    const t = setup({ pendingExit: new Promise<number>((r) => { endChild = r; }) });
    const p = t.run();
    await new Promise((r) => setTimeout(r, 10));
    t.handlers.SIGTERM!();
    await new Promise((r) => setTimeout(r, 10));
    expect(t.events.slice(3)).toEqual([...UNSET_EVENTS, "kill SIGHUP", "reap"]);
    expect(t.kills).toEqual(["SIGHUP"]);
    expect(t.exits).toEqual([143]);
    endChild(129);
    expect(await p).toBe(143);
    expect(t.tmux.slice(3)).toEqual(UNSET);
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
    t.handlers.SIGHUP!();
    await new Promise((r) => setTimeout(r, 10));
    expect(t.tmux).toEqual([]);
    expect(t.spawned[0]).toEqual(transportArgv(SPEC, viewScriptArgv(COORDS, viewSessionName(ID, "tdeadbeef"), "M-d", "tdeadbeef"), { tty: true }));
  });
  test("signal while child runs: run() waits for the reap, returns 129", async () => {
    let endChild!: (n: number) => void;
    let openGate!: () => void;
    const t = setup({ pendingExit: new Promise<number>((r) => { endChild = r; }), reapGate: new Promise<void>((r) => { openGate = r; }) });
    let result: number | undefined;
    const p = t.run().then((c) => { result = c; });
    await new Promise((r) => setTimeout(r, 10));
    t.handlers.SIGHUP!();
    endChild(1);
    await new Promise((r) => setTimeout(r, 10));
    expect(result).toBeUndefined();
    expect(t.exits).toEqual([]);
    openGate();
    await p;
    expect(result).toBe(129);
    expect(t.captures).toContainEqual(transportArgv(SPEC, reapScriptArgv("p12"), { tty: false }));
  });
  test("signal during get: nothing spawned", async () => {
    let openGate!: () => void;
    const t = setup();
    const orig = t.deps.capture;
    t.deps.capture = async (argv, ms) => { if (argv.includes("get")) { t.handlers.SIGTERM!(); } return orig(argv, ms); };
    void openGate;
    expect(await t.run()).toBe(143);
    expect(t.spawned).toEqual([]);
  });
  const refused: [string, Parameters<typeof setup>[0]][] = [
    ["not remote", { session: row({ remote: false }) }],
    ["not live", { session: row({ status: "closed" }) }],
    ["bad coords", { session: row({ remote_tmux: { ...COORDS, window: "x" } }) }],
    ["unsafe session id", { session: row({ session_id: "ab:cd.ef" }) }],
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
