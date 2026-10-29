import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { $ } from "bun";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  FAKE_OPENSHELL, makeTestEnv, waitFor, warmHub, cleanupAllTestEnvs, envOf, hubUrl, getJson, postIngest,
  writeSandboxShims, type TestEnv,
} from "./helpers.ts";

// Remote run and remote resume (Phase 3) end to end, with no OpenShell. The Mac runs
// `agmux run --remote t --sandbox box1` / `agmux attach <id>`; through the fake `openshell`
// the sandbox's own agmux (HOME=$FAKE_OS_DIR/box1) starts tests/e2e/stub-claude.sh
// directly on box1's default tmux server (the fake points TMUX_TMPDIR at box1's HOME);
// the stub's hooks register it with box1's hub and the Mac hub replicates the row. Local
// attaches land on an "outer" tmux server (the Mac's: -S, -f /dev/null). Nothing here
// touches the developer's tmux server.

const hasTmux = !!Bun.which("tmux");
const repo = path.resolve(__dirname, "..", "..");
const STUB = path.join(repo, "tests/e2e/stub-claude.sh");
// The [[remote]] launch args: odd strings must reach the agent verbatim.
const ARGS = ["--dangerously-skip-permissions", "two words; $HOME"];
const HOST = "gw/box1";
const STEP_MS = 20_000;

interface RemoteTmux { session: string; window: string; pane: string | null; socket: string | null; server?: string | null }
interface MacRow {
  session_id: string; status: string; host: string; native_session_id: string | null;
  command: string; args: string[]; cwd: string; remote_tmux: RemoteTmux | null;
}

let mac: TestEnv;
let box1: TestEnv;
let fakeDir = "";
let sbxCli = "";
let sbxSock = "";
let outerSock = "";
let workdir = "";
let macEnv: Record<string, string> = {};
let attachEnv: Record<string, string> = {};
let controlClient: ReturnType<typeof Bun.spawn> | null = null;

// One tmux call on a test server. Never the ambient server: always -S.
function tmux(sock: string, args: string[], env?: Record<string, string>): { ok: boolean; out: string } {
  const r = Bun.spawnSync(["tmux", "-u", "-f", "/dev/null", "-S", sock, ...args], {
    env: env ?? { PATH: process.env.PATH ?? "" }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  return { ok: r.exitCode === 0, out: r.stdout.toString() };
}

function tmuxOut(sock: string, args: string[], env?: Record<string, string>): string {
  const r = tmux(sock, args, env);
  if (!r.ok) throw new Error(`tmux ${args[0]} on ${path.basename(sock)} failed`);
  return r.out.trim();
}

function lines(s: string): string[] {
  return s.split("\n").filter((l) => l.length > 0);
}

function readLines(file: string): string[] {
  try { return lines(fs.readFileSync(file, "utf8")); } catch { return []; }
}

const calls = () => readLines(path.join(fakeDir, "calls.log"));
const launches = () => readLines(path.join(box1.root, "stub-claude.argv")).map((l) => l.split("\t"));
const prompts = () => readLines(path.join(box1.root, "stub-claude.prompts"));

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === "EPERM"; }
}

async function macRow(sid: string): Promise<MacRow> {
  return (await getJson<{ session: MacRow }>(`${hubUrl(mac)}/sessions/${sid}`)).session;
}

async function macRows(): Promise<MacRow[]> {
  return (await getJson<{ sessions: MacRow[] }>(`${hubUrl(mac)}/sessions?all=1&limit=1000&host=${encodeURIComponent(HOST)}`)).sessions;
}

async function waitForRow(match: (r: MacRow) => boolean): Promise<MacRow> {
  let hit: MacRow | undefined;
  await waitFor(async () => (hit = (await macRows()).find(match)) !== undefined, STEP_MS);
  return hit!;
}

const live = (r: MacRow) => ["idle", "done", "running", "waiting"].includes(r.status) && r.remote_tmux != null;

async function remoteRun(args: string[], env = macEnv, sandbox = "box1", remote = "t") {
  const r = await $`${mac.cliBin} run --remote ${remote} --sandbox ${sandbox} ${args}`.env(env).nothrow().quiet();
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

// A closed remote row: `attach` resumes it in the sandbox, then opens it locally.
async function resume(sid: string) {
  const r = await $`${mac.cliBin} attach ${sid} --placement new-window`.env(attachEnv).nothrow().quiet();
  return { code: r.exitCode, err: r.stderr.toString() };
}

function localPanes(sid: string): { window: string; pane: string }[] {
  const r = tmux(outerSock, ["list-panes", "-a", "-F", "#{window_id}\t#{pane_id}\t#{@agmux_session_id}"]);
  if (!r.ok) return [];
  return lines(r.out).map((l) => l.split("\t")).filter(([, , id]) => id === sid).map(([window = "", pane = ""]) => ({ window, pane }));
}

// Close the local window again, so a later attach of the same id never dedups onto it.
async function closeLocal(sid: string): Promise<void> {
  await waitFor(() => localPanes(sid).length === 1, STEP_MS);
  tmuxOut(outerSock, ["kill-window", "-t", localPanes(sid)[0]!.window]);
}

// The agent's pid as the sandbox hub knows it (the Mac masks it).
async function sandboxPid(sid: string): Promise<number> {
  return (await getJson<{ session: { pid: number } }>(`${hubUrl(box1)}/sessions/${sid}`)).session.pid;
}

// Once the agent's pid is gone, mark it lost the way the sandbox hub's pid sweep does
// (every 30 s: too slow to wait for), then wait for the Mac to see it closed.
async function markLost(sid: string, pid: number): Promise<void> {
  await waitFor(() => !isAlive(pid), STEP_MS);
  await postIngest(hubUrl(box1), {
    event_id: crypto.randomUUID(), ts: new Date().toISOString(), session_id: sid, kind: "session.lost",
    version: 1, host: HOST, payload: { reason: "pid_dead" },
  });
  await waitFor(async () => (await macRow(sid)).status === "lost", STEP_MS);
}

async function exitAgent(sid: string): Promise<void> {
  const pid = await sandboxPid(sid);
  const pane = (await macRow(sid)).remote_tmux!.pane!;
  tmuxOut(sbxSock, ["send-keys", "-t", pane, "-l", "/exit"]);
  tmuxOut(sbxSock, ["send-keys", "-t", pane, "Enter"]);
  await markLost(sid, pid);
}

const panesOf = (window: string) => lines(tmuxOut(sbxSock, ["list-panes", "-t", window, "-F", "#{pane_id}"]));

beforeAll(async () => {
  if (!hasTmux) return;
  mac = makeTestEnv();
  fakeDir = path.join(mac.root, "fake-os");
  fs.mkdirSync(fakeDir);
  box1 = makeTestEnv();
  fs.symlinkSync(box1.root, path.join(fakeDir, "box1"));
  sbxCli = writeSandboxShims(fakeDir);
  fs.writeFileSync(path.join(fakeDir, "list.json"), JSON.stringify({ next_page_token: "", sandboxes: [{ name: "box1" }] }));
  // Remote "old" lists nothing: no follower, so no host row and no version check.
  fs.writeFileSync(path.join(fakeDir, "list-gwold.json"), "[]");
  // An agmux from before Phase 3: its run parser takes the first unknown flag for the command.
  const oldCli = path.join(fakeDir, "old-agmux");
  fs.writeFileSync(oldCli, `#!/bin/sh\necho "agmux run: cannot infer agent_kind from '--direct'. Use --kind=claude, --kind=codex, or --kind=pi." >&2\nexit 2\n`);
  fs.chmodSync(oldCli, 0o755);
  workdir = path.join(box1.root, "work");
  fs.mkdirSync(workdir);
  sbxSock = path.join(fs.realpathSync(box1.root), `tmux-${process.getuid!()}`, "default");

  macEnv = envOf(mac, { FAKE_OS_DIR: fakeDir });
  // The image's claude hooks: sandbox starts are direct, so the adapter must be ready.
  const install = Bun.spawnSync([FAKE_OPENSHELL, "-g", "gw", "sandbox", "exec", "-n", "box1", "--no-tty", "--",
    sbxCli, "adapter", "install", "--kind", "claude", "--no-skills"], { env: macEnv, stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  if (install.exitCode !== 0) throw new Error(`adapter install: ${install.stderr.toString()}`);

  fs.appendFileSync(mac.configPath, `
[[remote]]
name = "t"
gateway = "gw"
interval = 0.2
openshell_bin = ${JSON.stringify(FAKE_OPENSHELL)}
agmux_bin = ${JSON.stringify(sbxCli)}
workdir = ${JSON.stringify(workdir)}
kind = "claude"
command = ${JSON.stringify(STUB)}
args = ${JSON.stringify(ARGS)}

[[remote]]
name = "old"
gateway = "gwold"
interval = 0.2
openshell_bin = ${JSON.stringify(FAKE_OPENSHELL)}
agmux_bin = ${JSON.stringify(oldCli)}
kind = "claude"
`);
  await warmHub(mac.cliBin, macEnv);   // the Mac hub; its follower starts box1's hub
  await waitFor(async () => {
    const { hosts } = await getJson<{ hosts: { host: string; last_sync_ok: boolean; agmux_version: string | null }[] }>(`${hubUrl(mac)}/hosts`);
    return hosts.some((h) => h.host === HOST && h.last_sync_ok && h.agmux_version !== null);
  }, STEP_MS);

  // The Mac's tmux. Its panes inherit this server's environment, not the test's. A
  // control-mode client stands in for the user's terminal (switch-client needs one).
  outerSock = path.join(mac.root, "outer.sock");
  const outerEnv = { ...macEnv, AGMUX_BIN: mac.cliBin, TERM: "screen" };
  tmuxOut(outerSock, ["new-session", "-d", "-s", "mac", "-x", "120", "-y", "40", "sleep 600",
    ";", "set-option", "-g", "default-terminal", "screen"], outerEnv);
  const [serverPid = "", macPane = ""] = tmuxOut(outerSock, ["display-message", "-p", "-t", "mac", "#{pid}\t#{pane_id}"]).split("\t");
  controlClient = Bun.spawn(["tmux", "-u", "-f", "/dev/null", "-S", outerSock, "-C", "attach-session", "-t", "mac"], {
    env: outerEnv, stdin: "pipe", stdout: "ignore", stderr: "ignore",
  });
  await waitFor(() => lines(tmux(outerSock, ["list-clients", "-F", "#{client_name}"]).out).length === 1, STEP_MS);
  // `agmux` as run from the `mac` pane.
  attachEnv = { ...macEnv, AGMUX_BIN: mac.cliBin, TMUX: `${outerSock},${serverPid},0`, TMUX_PANE: macPane };
}, 60_000);

afterAll(() => {
  if (!hasTmux) return;
  try { controlClient?.kill(); } catch { /* gone */ }
  for (const sock of [outerSock, sbxSock]) {
    if (sock) tmux(sock, ["kill-server"]);
  }
  cleanupAllTestEnvs();
});

describe.skipIf(!hasTmux)("remote run and resume through a fake openshell", () => {
  let sidA = "";   // started with -d from the [[remote]] launch
  let sidB = "";   // started with a CLI launch override, attached

  test("run -d starts the [[remote]] launch; the row replicates with that launch and the prompt arrives verbatim", async () => {
    const prompt = `say "hi"; echo $HOME 'q'`;
    const r = await remoteRun(["-d", "--prompt", prompt]);
    expect(r.code).toBe(0);
    const m = /^agmux: started on gw\/box1 \(agmux:(@\d+)\)$/m.exec(r.out);
    expect(m).not.toBeNull();

    // Every value is its own argv element in the sandbox, nothing shell-joined.
    const argv = ["-g", "gw", "sandbox", "exec", "-n", "box1", "--no-tty", "--", sbxCli, "run", "--direct", "--print-coords",
      "--cwd", workdir, "--prompt", prompt, "--kind", "claude", "--", STUB, ...ARGS];
    expect(calls()).toContain(argv.join("\t"));

    const row = await waitForRow((s) => live(s) && s.remote_tmux!.window === m![1]);
    sidA = row.session_id;
    expect(row.command).toBe(STUB);
    expect(row.args).toEqual(ARGS);
    expect([workdir, fs.realpathSync(workdir)]).toContain(row.cwd);
    expect(row.remote_tmux!.server).toMatch(/^\d+-\d+$/);
    expect(launches()).toEqual([ARGS]);
    await waitFor(() => prompts().includes(prompt), STEP_MS);
  }, 60_000);

  test("run with a CLI launch override attaches a local window running the remote client", async () => {
    const r = await remoteRun(["--new-window", "--kind", "claude", "--", STUB, "--override", "x y"], attachEnv);
    expect(r.code).toBe(0);
    const row = await waitForRow((s) => live(s) && s.args.join("\t") === "--override\tx y");
    sidB = row.session_id;
    expect(row.command).toBe(STUB);
    await closeLocal(sidB);
  }, 60_000);

  test("headless run starts a stopped sandbox, streams the reply and propagates the exit code", async () => {
    const stopped = path.join(box1.root, "sandbox.json");
    fs.writeFileSync(stopped, JSON.stringify({ phase: "Stopped" }));
    const prompt = `line one "q"; $HOME\nline two`;
    let r;
    try { r = await remoteRun(["--headless", "--prompt", prompt]); }
    finally { fs.rmSync(stopped); }
    expect(r.code).toBe(3);
    expect(r.out).toBe(`${prompt}\n`);
    expect(calls()).toContain(["-g", "gw", "sandbox", "start", "box1"].join("\t"));
  }, 60_000);

  test("resume after the agent exits: same id, split into its old window, launch args kept", async () => {
    const before = await macRow(sidA);
    const old = before.remote_tmux!;
    // A shell next to the agent keeps its window alive after the agent exits.
    tmuxOut(sbxSock, ["split-window", "-d", "-t", old.pane!, "sleep 600"]);
    await exitAgent(sidA);

    expect(await resume(sidA)).toEqual({ code: 0, err: "" });
    const after = await macRow(sidA);
    expect(live(after)).toBe(true);
    expect(after.remote_tmux!.server).toBe(old.server!);
    expect(after.remote_tmux!.window).toBe(old.window);
    expect(after.remote_tmux!.pane).not.toBe(old.pane);
    expect(panesOf(old.window)).toHaveLength(2);
    expect(after.args).toEqual(ARGS);
    expect(launches().at(-1)).toEqual(["--resume", before.native_session_id!, ...ARGS]);
    await closeLocal(sidA);
  }, 60_000);

  test("resume when its window is gone: a new window in the old session", async () => {
    const before = await macRow(sidB);
    const old = before.remote_tmux!;
    await exitAgent(sidB);

    expect(await resume(sidB)).toEqual({ code: 0, err: "" });
    const after = await macRow(sidB);
    expect(live(after)).toBe(true);
    expect(after.remote_tmux!.session).toBe(old.session);
    expect(after.remote_tmux!.window).not.toBe(old.window);
    expect(after.args).toEqual(["--override", "x y"]);
    expect(launches().at(-1)).toEqual(["--resume", before.native_session_id!, "--override", "x y"]);
    await closeLocal(sidB);
  }, 60_000);

  test("a hand-started agent resumes with the [[remote]] launch as fallback", async () => {
    // Started by hand in the sandbox: its row has no recorded launch (command = kind, no args).
    const pane = tmuxOut(sbxSock, ["new-window", "-d", "-t", "agmux:", "-P", "-F", "#{pane_id}", STUB]);
    const row = await waitForRow((s) => live(s) && s.remote_tmux!.pane === pane);
    expect(row.command).toBe("claude");
    expect(row.args).toEqual([]);
    await exitAgent(row.session_id);

    expect(await resume(row.session_id)).toEqual({ code: 0, err: "" });
    const fallback = JSON.stringify({ profile: null, command: STUB, args: ARGS });
    expect(calls().some((l) => l.endsWith(["attach", row.session_id, "--resume-nearest", "--print-coords", "--fallback-launch", fallback].join("\t"))))
      .toBe(true);
    const after = await macRow(row.session_id);
    expect(live(after)).toBe(true);
    expect(after.command).toBe(STUB);
    expect(after.args).toEqual(ARGS);
    expect(launches().at(-1)).toEqual(["--resume", row.native_session_id!, ...ARGS]);
    await closeLocal(row.session_id);
  }, 60_000);

  test("resume after the sandbox tmux server restarted: a new session, never the reused window", async () => {
    const before = await macRow(sidA);
    const old = before.remote_tmux!;
    const pid = await sandboxPid(sidA);
    tmuxOut(sbxSock, ["kill-server"]);
    await markLost(sidA, pid);

    expect(await resume(sidA)).toEqual({ code: 0, err: "" });
    const after = await macRow(sidA);
    expect(live(after)).toBe(true);
    expect(after.session_id).toBe(sidA);
    expect(after.remote_tmux!.server).not.toBe(old.server!);
    expect(after.remote_tmux!.session).toBe(old.session);
    expect(panesOf(after.remote_tmux!.window)).toEqual([after.remote_tmux!.pane!]);
    expect(lines(tmuxOut(sbxSock, ["list-windows", "-a", "-F", "#{window_id}"]))).toHaveLength(1);
    expect(after.args).toEqual(ARGS);
    expect(launches().at(-1)).toEqual(["--resume", before.native_session_id!, ...ARGS]);
    await closeLocal(sidA);
  }, 60_000);

  test("a missing sandbox is named, nothing is started", async () => {
    const r = await remoteRun(["-d"], macEnv, "nope");
    expect(r.code).toBe(2);
    expect(r.err).toContain("agmux run: sandbox nope not found on remote t (gateway gw)");
    expect(calls().some((l) => l.includes(["exec", "-n", "nope"].join("\t")))).toBe(false);
  }, 30_000);

  test("a sandbox with an older agmux asks for a restage", async () => {
    const r = await remoteRun(["-d"], macEnv, "box1", "old");
    expect(r.code).toBe(2);
    expect(r.err.trim()).toBe("gwold/box1 runs an older agmux; restage the image (stage-agmux)");
  }, 30_000);
});
