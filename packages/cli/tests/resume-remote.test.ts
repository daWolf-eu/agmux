import { describe, expect, test } from "bun:test";
import { AGMUX_VERSION, type HostRow, type RemoteTmux, type SessionRow } from "@agmux/protocol";
import { openshellTransport, transportArgv, type RemoteConfig, type SandboxStatus } from "@agmux/hub";
import type { AttachRequest } from "@agmux/tui";
import { attachCtxFor, attachSettingsFrom } from "../src/attach-place.ts";
import { resumeRemote, type ResumeRemoteDeps } from "../src/resume-remote.ts";

const ID = "11111111-2222-4333-8444-555555555555";
const NEW_ID = "99999999-2222-4333-8444-555555555555";
const HOST = "gw/wi-1";
const SETTINGS = attachSettingsFrom({ terminal: {}, remote: {} }, "/bin/agmux");
const LAUNCH_ARGS = ["--dangerously-skip-permissions"];

function remoteCfg(over: Partial<RemoteConfig> = {}): RemoteConfig {
  return {
    name: "ai-sandbox", transport: "openshell", gateway: "gw", selector: "agmux=1", interval: 5,
    openshell_bin: "/bin/os", agmux_bin: "/usr/local/bin/agmux", workdir: "/sandbox/work",
    launch: { kind: "claude", profile: null, command: null, args: LAUNCH_ARGS },
    ...over,
  };
}

const SPEC = openshellTransport(remoteCfg()).spec("wi-1");
const OLD: RemoteTmux = { session: "agmux", window: "@3", pane: "%7", socket: null, server: "100-200" };
const PRINTED: RemoteTmux = { session: "agmux", window: "@0", pane: "%0", socket: null, server: "300-400" };

function row(over: Partial<SessionRow> = {}): SessionRow {
  return {
    tmux_server: null,
    session_id: ID, agent_kind: "claude", profile: null, native_session_id: "n1",
    command: "claude", args: [], env_overrides: {}, cwd: "/sandbox/work", pid: null,
    tmux_session: null, tmux_window: null, tmux_pane: null, tmux_socket: null,
    host: HOST, project: null, parent_session_id: null,
    start_ts: "2026-10-29T10:00:00.000Z", last_heartbeat_ts: null,
    end_ts: "2026-10-29T11:00:00.000Z", exit_code: null, signal: null, status: "lost", origin: "native",
    remote: true, remote_tmux: { ...OLD }, remote_pid: 7,
    ...over,
  };
}

const live = (over: Partial<SessionRow> = {}) => row({ status: "idle", end_ts: null, remote_tmux: { ...PRINTED }, ...over });

function hostRow(over: Partial<HostRow> = {}): HostRow {
  return {
    host: HOST, remote: "ai-sandbox", transport: SPEC,
    last_sync_ts: null, last_sync_ok: true, last_error: null,
    cursor: 0, db_id: null, agmux_version: AGMUX_VERSION,
    replication: 1, rejected: 0, removed_ts: null,
    ...over,
  };
}

interface SetupOpts {
  remotes?: RemoteConfig[] | (() => RemoteConfig[]);
  hosts?: HostRow[];
  status?: SandboxStatus;
  exec?: { code: number; stdout: string; stderr: string };
  polls?: SessionRow[][];  // /sessions responses, one per poll (the last one repeats)
  env?: Record<string, string | undefined>;
  attachError?: string;
}

function setup(o: SetupOpts = {}) {
  const calls: string[] = [];
  const execs: string[][] = [];
  const attaches: { row: SessionRow; req: AttachRequest | undefined }[] = [];
  let t = 0;
  let poll = 0;
  const polls = o.polls ?? [[live()]];
  const deps: ResumeRemoteDeps = {
    fetchImpl: (async (url: string, init?: RequestInit) => {
      const u = String(url);
      calls.push(`${init?.method ?? "GET"} ${u.replace("http://hub", "")}`);
      if (u.endsWith("/hosts")) return Response.json({ hosts: o.hosts ?? [hostRow()], remotes: [] });
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
    attachRemote: async (r, req) => {
      calls.push("attach"); attaches.push({ row: r, req });
      if (o.attachError) throw new Error(o.attachError);
      return { argv: ["handoff"] };
    },
    now: () => t,
    sleep: async (ms) => { t += ms; },
  };
  const remotes = typeof o.remotes === "function" ? o.remotes : () => (o.remotes as RemoteConfig[] | undefined) ?? [remoteCfg(), remoteCfg({ name: "other" })];
  const ctx = attachCtxFor(SETTINGS, o.env ?? { TMUX: "/tmp/tmux-501/default,1,0" }, false);
  const resume = (r: SessionRow = row(), req?: AttachRequest) =>
    resumeRemote(r, req, { ctx, settings: SETTINGS, hubUrl: "http://hub", remotes }, deps);
  return { calls, execs, attaches, resume };
}

const sandboxArgv = (cmd: string[]) => transportArgv(SPEC, cmd, { tty: false });
const GONE = `resume: sandbox ${HOST} is gone; cannot resume`;

describe("resumeRemote", () => {
  test("resumes nearest in the sandbox with the [[remote]] fallback launch, kicks, waits, attaches", async () => {
    const s = setup();
    const req: AttachRequest = { placement: "new-window" };
    expect(await s.resume(row(), req)).toEqual({ argv: ["handoff"] });
    expect(s.execs).toEqual([sandboxArgv([
      "/usr/local/bin/agmux", "attach", ID, "--resume-nearest", "--print-coords",
      "--fallback-launch", JSON.stringify({ profile: null, command: "claude", args: LAUNCH_ARGS }),
    ])]);
    expect(s.attaches).toEqual([{ row: live(), req }]);
    expect(s.calls).toEqual(["GET /hosts", "status", "exec", `POST /hosts/${encodeURIComponent(HOST)}/sync`,
      `GET /sessions?all=1&limit=1000&host=${encodeURIComponent(HOST)}`, "attach"]);
  });

  test("fallback launch: configured command, profile; no launch → no --fallback-launch", async () => {
    const tail = async (launch: RemoteConfig["launch"]) => {
      const s = setup({ remotes: [remoteCfg({ launch })] });
      await s.resume();
      return s.execs[0]!.slice(sandboxArgv([]).length + 5);
    };
    expect(await tail({ kind: "claude", profile: null, command: "/opt/claude", args: [] }))
      .toEqual(["--fallback-launch", JSON.stringify({ profile: null, command: "/opt/claude", args: [] })]);
    expect(await tail({ kind: null, profile: "work", command: null, args: [] }))
      .toEqual(["--fallback-launch", JSON.stringify({ profile: "work", command: "claude", args: [] })]);
    expect(await tail(null)).toEqual([]);
  });

  test("a host whose remote is not configured uses the default agmux and no fallback", async () => {
    const s = setup({ remotes: [remoteCfg({ name: "other" })] });
    await s.resume();
    expect(s.execs[0]!.slice(sandboxArgv([]).length)).toEqual(["agmux", "attach", ID, "--resume-nearest", "--print-coords"]);
  });

  test("a broken config fails before anything runs in the sandbox", async () => {
    const s = setup({ remotes: () => { throw new Error("bad toml"); } });
    await expect(s.resume()).rejects.toThrow("resume: bad toml");
    expect(s.calls).toEqual(["GET /hosts"]);
  });

  test("a relaunched-fresh session (new session id) is matched on the printed coords", async () => {
    const fresh = live({ session_id: NEW_ID });
    const s = setup({ polls: [[row()], [row(), fresh]] });
    await s.resume();
    expect(s.attaches.map((a) => a.row)).toEqual([fresh]);
  });

  test("the wait ignores a closed row and a row on another tmux server with the printed pane", async () => {
    const closedHere = row({ remote_tmux: { ...PRINTED } });
    const otherServer = live({ session_id: NEW_ID, remote_tmux: { ...PRINTED, server: "1-2" } });
    const s = setup({ polls: [[closedHere, otherServer], [closedHere, otherServer, live()]] });
    await s.resume();
    expect(s.attaches.map((a) => a.row)).toEqual([live()]);
  });

  test("the kick is POSTed before the first /sessions poll", async () => {
    const s = setup();
    await s.resume();
    const kick = s.calls.findIndex((c) => c.startsWith("POST") && c.endsWith("/sync"));
    const firstPoll = s.calls.findIndex((c) => c.includes("/sessions"));
    expect(kick).toBeGreaterThan(s.calls.indexOf("exec"));
    expect(kick).toBeLessThan(firstPoll);
  });

  test("timeout: started, but not replicated → error with the ls hint, no attach", async () => {
    const s = setup({ polls: [[row()]] });
    await expect(s.resume()).rejects.toThrow(
      `resume: started in ${HOST}, but the session has not replicated yet; run agmux ls --host ${HOST}`);
    expect(s.attaches).toEqual([]);
  });

  test("gone: no host row, removed host, no transport, missing sandbox → error, no exec", async () => {
    for (const o of [
      { hosts: [] }, { hosts: [hostRow({ removed_ts: "2026-10-29T12:00:00.000Z" })] },
      { hosts: [hostRow({ transport: null })] }, { status: { state: "missing", detail: "not found" } as SandboxStatus },
    ]) {
      const s = setup(o);
      await expect(s.resume()).rejects.toThrow(GONE);
      expect(s.execs).toEqual([]);
    }
  });

  test("a stopped sandbox is started before the exec", async () => {
    const s = setup({ status: { state: "stopped" } });
    await s.resume();
    expect(s.calls.slice(0, 4)).toEqual(["GET /hosts", "status", "start", "exec"]);
  });

  test("host row on another agmux version → restage message after the status check, no exec", async () => {
    const s = setup({ hosts: [hostRow({ agmux_version: "0.0.1" })] });
    await expect(s.resume()).rejects.toThrow(`${HOST} runs an older agmux; restage the image (stage-agmux)`);
    expect(s.calls).toEqual(["GET /hosts", "status"]);
  });

  test("an old sandbox agmux ignoring --resume-nearest (exit 0, no coords) → restage message", async () => {
    const s = setup({ exec: { code: 0, stdout: "", stderr: "open terminal failed: not a terminal\n" } });
    await expect(s.resume()).rejects.toThrow(`${HOST} runs an older agmux; restage the image (stage-agmux)`);
    expect(s.attaches).toEqual([]);
  });

  test("a failing sandbox resume reports its sanitized stderr", async () => {
    const s = setup({ exec: { code: 1, stdout: "", stderr: "attach --resume-nearest: boom\u001b[31m\n" } });
    await expect(s.resume()).rejects.toThrow(`resume: ${HOST}: attach --resume-nearest: boom`);
    const s2 = setup({ exec: { code: 2, stdout: "", stderr: "" } });
    await expect(s2.resume()).rejects.toThrow(`resume: ${HOST}: exited 2`);
  });

  test("a placement impossible here fails before anything starts", async () => {
    const s = setup({ env: {} });
    await expect(s.resume(row(), { placement: "new-pane" })).rejects.toThrow(/^resume: /);
    expect(s.calls).toEqual([]);
  });

  test("an odd sandbox name in the host's transport or an odd session id is refused before any exec", async () => {
    const s = setup({ hosts: [hostRow({ transport: { ...SPEC, target: "wi-1;rm -rf /" } })] });
    await expect(s.resume()).rejects.toThrow("resume: ");
    expect(s.execs).toEqual([]);
    const s2 = setup();
    await expect(s2.resume(row({ session_id: "x; true" }))).rejects.toThrow("resume: invalid session id");
    expect(s2.calls).toEqual([]);
  });

  test("a live row (headless, no coords) is never resumed", async () => {
    const s = setup();
    await expect(s.resume(live({ remote_tmux: null }))).rejects.toThrow(`resume: 11111111 is still running on ${HOST}; nothing to resume`);
    expect(s.calls).toEqual([]);
  });

  test("an attach failure after the resume is reported as a resume error", async () => {
    const s = setup({ attachError: "new-pane: cannot read the current tmux pane" });
    await expect(s.resume()).rejects.toThrow("resume: new-pane: cannot read the current tmux pane");
  });
});
