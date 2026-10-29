import { describe, expect, test } from "bun:test";
import { AGMUX_VERSION, type RemoteTmux, type SessionRow } from "@agmux/protocol";
import { openshellTransport, transportArgv, type RemoteConfig, type SandboxStatus } from "@agmux/hub";
import type { AttachRequest } from "@agmux/tui";
import { parseRunArgs } from "../src/parse-run.ts";
import { attachSettingsFrom } from "../src/attach-place.ts";
import {
  isRemoteRun, resolveRemoteLaunch, runRemote, sandboxRunArgv, waitForRemoteRow,
  type RemoteRun, type RunRemoteDeps,
} from "../src/run-remote.ts";

const ID = "11111111-2222-4333-8444-555555555555";
const HOST = "gw/wi-1";
const SETTINGS = attachSettingsFrom({ terminal: {}, remote: {} }, "/bin/agmux");

function remoteCfg(over: Partial<RemoteConfig> = {}): RemoteConfig {
  return {
    name: "ai-sandbox", transport: "openshell", gateway: "gw", selector: "agmux=1", interval: 5,
    openshell_bin: "/bin/os", agmux_bin: "/usr/local/bin/agmux", workdir: "/sandbox/work",
    launch: { kind: "claude", profile: null, command: null, args: ["--dangerously-skip-permissions"] },
    ...over,
  };
}

const SPEC = openshellTransport(remoteCfg()).spec("wi-1");
const PRINTED: RemoteTmux = { session: "agmux", window: "@3", pane: "%7", socket: null, server: "100-200" };

function row(over: Partial<SessionRow> = {}): SessionRow {
  return {
    tmux_server: null,
    session_id: ID, agent_kind: "claude", profile: null, native_session_id: null,
    command: "claude", args: [], env_overrides: {}, cwd: "/sandbox/work", pid: null,
    tmux_session: null, tmux_window: null, tmux_pane: null, tmux_socket: null,
    host: HOST, project: null, parent_session_id: null,
    start_ts: "2026-10-29T10:00:00.000Z", last_heartbeat_ts: null,
    end_ts: null, exit_code: null, signal: null, status: "idle", origin: "native",
    remote: true, remote_tmux: { ...PRINTED }, remote_pid: 7,
    ...over,
  };
}

function parsed(argv: string[]): RemoteRun {
  const p = parseRunArgs(["--remote", "ai-sandbox", "--sandbox", "wi-1", ...argv]);
  if (!isRemoteRun(p)) throw new Error(`not a remote run: ${JSON.stringify(p)}`);
  return p;
}

interface SetupOpts {
  remotes?: RemoteConfig[];
  status?: SandboxStatus;
  hostVersion?: string | null;
  exec?: { code: number; stdout: string; stderr: string };
  headlessCode?: number;
  // /sessions responses, one per poll (the last one repeats).
  polls?: SessionRow[][];
  env?: Record<string, string | undefined>;
}

function setup(o: SetupOpts = {}) {
  const calls: string[] = [];
  const execs: string[][] = [];
  const inherits: string[][] = [];
  const attaches: { row: SessionRow; req: AttachRequest | undefined }[] = [];
  const out: string[] = [];
  const err: string[] = [];
  let t = 0;
  let poll = 0;
  const polls = o.polls ?? [[row()]];
  const deps: RunRemoteDeps = {
    remotes: () => o.remotes ?? [remoteCfg(), remoteCfg({ name: "other" })],
    fetchImpl: (async (url: string, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      calls.push(`${method} ${u.replace("http://hub", "")}`);
      if (u.endsWith("/hosts")) {
        const hosts = o.hostVersion === undefined ? [] : [{ host: HOST, agmux_version: o.hostVersion }];
        return Response.json({ hosts, remotes: [] });
      }
      if (u.includes("/sync")) return new Response(null, { status: 204 });
      if (u.includes("/sessions")) {
        const sessions = polls[Math.min(poll, polls.length - 1)];
        poll++;
        return Response.json({ sessions });
      }
      return new Response(null, { status: 404 });
    }) as unknown as typeof fetch,
    control: {
      status: async () => { calls.push("status"); return o.status ?? { state: "ready" }; },
      start: async () => { calls.push("start"); },
    },
    exec: async (argv) => {
      calls.push("exec"); execs.push(argv);
      return o.exec ?? { code: 0, stdout: `${JSON.stringify({ remote_tmux: PRINTED })}\n`, stderr: "" };
    },
    execInherit: async (argv) => { calls.push("execInherit"); inherits.push(argv); return o.headlessCode ?? 0; },
    attachRemote: async (r, req) => { calls.push("attach"); attaches.push({ row: r, req }); return null; },
    runHandoff: async () => 0,
    now: () => t,
    sleep: async (ms) => { t += ms; },
    out: (s) => out.push(s),
    err: (s) => err.push(s),
  };
  const run = (argv: string[], prompt?: string) => runRemote(
    { parsed: parsed(argv), prompt, hubUrl: "http://hub", env: o.env ?? { TMUX: "/tmp/tmux-501/default,1,0" }, settings: SETTINGS },
    deps,
  );
  return { deps, calls, execs, inherits, attaches, out, err, run };
}

describe("resolveRemoteLaunch + sandboxRunArgv", () => {
  const argvFor = (argv: string[], cfg = remoteCfg(), o: { cwd?: string; prompt?: string; headless?: boolean } = {}) => {
    const p = parsed(argv);
    const l = resolveRemoteLaunch(p, cfg);
    if ("error" in l) throw new Error(l.error);
    return sandboxRunArgv(cfg, l, { cwd: o.cwd ?? null, prompt: o.prompt, headless: o.headless ?? false });
  };

  test("config launch", () => {
    expect(argvFor([])).toEqual([
      "/usr/local/bin/agmux", "run", "--direct", "--print-coords", "--cwd", "/sandbox/work",
      "--kind", "claude", "--", "claude", "--dangerously-skip-permissions",
    ]);
  });

  test("config command replaces the kind's binary", () => {
    const cfg = remoteCfg({ launch: { kind: "claude", profile: null, command: "/opt/claude", args: [] } });
    expect(argvFor([], cfg).slice(-4)).toEqual(["--kind", "claude", "--", "/opt/claude"]);
  });

  test("config profile", () => {
    const cfg = remoteCfg({ launch: { kind: null, profile: "work", command: null, args: [] } });
    expect(argvFor([], cfg).slice(-2)).toEqual(["-p", "work"]);
  });

  test("-p on the CLI wins over the config launch", () => {
    expect(argvFor(["-p", "x"]).slice(-2)).toEqual(["-p", "x"]);
  });

  test("positional command with --kind replaces the config command and args", () => {
    expect(argvFor(["--kind", "codex", "--", "codex", "--y"]).slice(-5)).toEqual(["--kind", "codex", "--", "codex", "--y"]);
  });

  test("--kind alone: the config launch when it is that kind, else the kind's bare binary", () => {
    expect(argvFor(["--kind", "claude"]).slice(-5)).toEqual(["--kind", "claude", "--", "claude", "--dangerously-skip-permissions"]);
    expect(argvFor(["--kind", "codex"]).slice(-4)).toEqual(["--kind", "codex", "--", "codex"]);
    expect(argvFor(["--kind", "codex"], remoteCfg({ launch: null })).slice(-4)).toEqual(["--kind", "codex", "--", "codex"]);
  });

  test("no launch anywhere → error", () => {
    expect(resolveRemoteLaunch(parsed([]), remoteCfg({ launch: null }))).toEqual({
      error: "agmux run --remote: no agent configured for remote ai-sandbox (set kind/profile in [[remote]] or pass --kind/-p)",
    });
  });

  test("workdir → --cwd; --cwd wins; neither → no --cwd", () => {
    expect(argvFor([]).slice(4, 6)).toEqual(["--cwd", "/sandbox/work"]);
    expect(argvFor([], remoteCfg(), { cwd: "/o" }).slice(4, 6)).toEqual(["--cwd", "/o"]);
    expect(argvFor([], remoteCfg({ workdir: null }))).not.toContain("--cwd");
  });

  test("headless + prompt", () => {
    expect(argvFor([], remoteCfg(), { headless: true, prompt: "hi" }).slice(0, 7)).toEqual([
      "/usr/local/bin/agmux", "run", "--headless", "--cwd", "/sandbox/work", "--prompt", "hi",
    ]);
  });
});

describe("runRemote", () => {
  test("starts in the sandbox through the transport, kicks, waits, attaches the row", async () => {
    const s = setup();
    expect(await s.run([])).toBe(0);
    expect(s.execs).toEqual([transportArgv(SPEC, [
      "/usr/local/bin/agmux", "run", "--direct", "--print-coords", "--cwd", "/sandbox/work",
      "--kind", "claude", "--", "claude", "--dangerously-skip-permissions",
    ], { tty: false })]);
    expect(s.attaches).toEqual([{ row: row(), req: undefined }]);
    expect(s.err).toEqual([]);
  });

  test("prompt text with quotes, ;, $HOME and a newline is one argv element", async () => {
    const s = setup();
    const prompt = `a 'b' "c"; $HOME\nd`;
    await s.run(["--prompt", prompt], prompt);
    const argv = s.execs[0]!;
    expect(argv[argv.indexOf("--prompt") + 1]).toBe(prompt);
    expect(argv.filter((a) => a === prompt)).toHaveLength(1);
  });

  test("the kick is POSTed before the first /sessions poll", async () => {
    const s = setup();
    await s.run([]);
    const kick = s.calls.indexOf(`POST /hosts/${encodeURIComponent(HOST)}/sync`);
    const firstPoll = s.calls.findIndex((c) => c.startsWith("GET /sessions"));
    expect(kick).toBeGreaterThan(s.calls.indexOf("exec"));
    expect(kick).toBeGreaterThanOrEqual(0);
    expect(firstPoll).toBeGreaterThan(kick);
  });

  test("the wait ignores a row with the same pane on another tmux server", async () => {
    const stale = row({ session_id: "22222222-2222-4333-8444-555555555555", remote_tmux: { ...PRINTED, server: "9-9" } });
    const s = setup({ polls: [[stale], [stale, row()]] });
    expect(await s.run([])).toBe(0);
    expect(s.attaches.map((a) => a.row.session_id)).toEqual([ID]);
  });

  test("placement flags map to the attach request; none = [attach.remote] default", async () => {
    for (const [flag, placement] of [["--new-pane", "new-pane"], ["--new-window", "new-window"], ["--new-session", "new-session"]] as const) {
      const s = setup();
      await s.run([flag]);
      expect(s.attaches[0]!.req).toEqual({ placement });
    }
  });

  test("a placement impossible here fails before anything starts", async () => {
    const s = setup({ env: {} });
    expect(await s.run(["--new-pane"])).toBe(2);
    expect(s.calls).not.toContain("exec");
    expect(s.err[0]).toMatch(/new pane: not in tmux/);
  });

  test("-d prints where it started and never polls or attaches", async () => {
    const s = setup();
    expect(await s.run(["-d"])).toBe(0);
    expect(s.out).toEqual(["agmux: started on gw/wi-1 (agmux:@3)"]);
    expect(s.calls.some((c) => c.includes("/sessions") || c.includes("/sync"))).toBe(false);
    expect(s.attaches).toEqual([]);
  });

  test("timeout: started, but not replicated → exit 1 with the ls hint", async () => {
    const s = setup({ polls: [[]] });
    expect(await s.run([])).toBe(1);
    expect(s.err).toEqual(["agmux: started, but the session has not replicated yet; run agmux ls --host gw/wi-1"]);
    expect(s.attaches).toEqual([]);
  });

  test("unknown remote → exit 2 listing the configured names, no exec", async () => {
    const s = setup({ remotes: [remoteCfg({ name: "a" }), remoteCfg({ name: "b" })] });
    expect(await s.run([])).toBe(2);
    expect(s.err).toEqual(['agmux run --remote: unknown remote "ai-sandbox" (configured: a, b)']);
    expect(s.calls).not.toContain("exec");
  });

  test("a bad sandbox name is refused before any exec", async () => {
    const s = setup();
    const p = { ...parsed([]), remote: { name: "ai-sandbox", sandbox: "x;rm -rf /" } };
    expect(await runRemote({ parsed: p, hubUrl: "http://hub", env: {}, settings: SETTINGS }, s.deps)).toBe(2);
    expect(s.calls).toEqual([]);
  });

  test("missing sandbox → exit 2", async () => {
    const s = setup({ status: { state: "missing", detail: "not found" } });
    expect(await s.run([])).toBe(2);
    expect(s.err[0]).toBe("agmux run: sandbox wi-1 not found on remote ai-sandbox (gateway gw)");
    expect(s.calls).not.toContain("exec");
  });

  test("a stopped sandbox is started before the exec", async () => {
    const s = setup({ status: { state: "stopped" } });
    expect(await s.run([])).toBe(0);
    expect(s.calls.indexOf("start")).toBeLessThan(s.calls.indexOf("exec"));
  });

  test("host row on another agmux version → restage message, no exec", async () => {
    const s = setup({ hostVersion: "0.0.1" });
    expect(await s.run([])).toBe(2);
    expect(s.err).toEqual(["gw/wi-1 runs an older agmux; restage the image (stage-agmux)"]);
    expect(s.calls).not.toContain("exec");
  });

  test("host row on this version proceeds", async () => {
    expect(await setup({ hostVersion: AGMUX_VERSION }).run([])).toBe(0);
  });

  test("old sandbox agmux rejecting --direct → restage message, not a parse error", async () => {
    const s = setup({ exec: { code: 2, stdout: "", stderr: "agmux run: cannot infer agent_kind from '--direct'. Use --kind=claude." } });
    expect(await s.run([])).toBe(2);
    expect(s.err).toEqual(["gw/wi-1 runs an older agmux; restage the image (stage-agmux)"]);
  });

  test("a failing sandbox run passes its exit code and stderr", async () => {
    const s = setup({ exec: { code: 2, stdout: "", stderr: "no adapter\n" } });
    expect(await s.run([])).toBe(2);
    expect(s.err).toEqual(["agmux run: gw/wi-1: no adapter"]);
  });

  test("unparseable coords → exit 1 with the sandbox stderr", async () => {
    const s = setup({ exec: { code: 0, stdout: "hello\n", stderr: "warn: x\n" } });
    expect(await s.run([])).toBe(1);
    expect(s.err).toEqual(["agmux run: gw/wi-1 printed no coordinates: warn: x"]);
    expect(s.calls).not.toContain("attach");
  });

  test("headless: inherited output, exit code passed through, no wait or attach", async () => {
    const s = setup({ headlessCode: 3 });
    expect(await s.run(["--headless", "--prompt", "hi"], "hi")).toBe(3);
    expect(s.inherits).toEqual([transportArgv(SPEC, [
      "/usr/local/bin/agmux", "run", "--headless", "--cwd", "/sandbox/work", "--prompt", "hi",
      "--kind", "claude", "--", "claude", "--dangerously-skip-permissions",
    ], { tty: false })]);
    expect(s.calls.some((c) => c.includes("/sessions") || c.includes("/sync") || c === "exec" || c === "attach")).toBe(false);
  });
});

describe("waitForRemoteRow", () => {
  test("a printed null server matches on pane and window alone", async () => {
    const s = setup({ polls: [[row({ remote_tmux: { ...PRINTED, server: "5-5" } })]] });
    s.deps.exec = async () => ({ code: 0, stdout: JSON.stringify({ remote_tmux: { ...PRINTED, server: null } }), stderr: "" });
    expect(await s.run([])).toBe(0);
    expect(s.attaches).toHaveLength(1);
  });

  test("other host / window never match; hub errors are retried until the timeout", async () => {
    let t = 0;
    let n = 0;
    const got = await waitForRemoteRow({
      hubUrl: "http://hub", host: HOST,
      fetchImpl: (async () => {
        n++;
        if (n === 1) throw new Error("down");
        return Response.json({ sessions: [row({ host: "gw/other" }), row({ remote_tmux: { ...PRINTED, window: "@4" } })] });
      }) as unknown as typeof fetch,
      match: (r) => r.remote_tmux?.pane === "%7" && r.remote_tmux.window === "@3",
      timeoutMs: 2000, pollMs: 500, now: () => t, sleep: async (ms) => { t += ms; },
    });
    expect(got).toBeNull();
    expect(n).toBe(5);
  });
});
