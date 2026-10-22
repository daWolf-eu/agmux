import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { $ } from "bun";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTestEnv, waitFor, warmHub, cleanupAllTestEnvs, type TestEnv } from "./helpers.ts";

// Remote attach end to end, with no OpenShell: a sandbox hub (HOME=$FAKE_OS_DIR/box1)
// whose session lives on an "inner" tmux server (the sandbox's tmux), the Mac hub
// replicating it through the fake `openshell`, and an "outer" tmux server (the Mac's)
// where `agmux attach` places the local window. Both servers run on their own
// sockets with `-f /dev/null`: nothing here touches the developer's tmux server.

const hasTmux = !!Bun.which("tmux");
const repo = path.resolve(__dirname, "..", "..");
const fakeOpenshell = path.join(repo, "tests/e2e/fake-openshell.sh");
const STEP_MS = 5_000;

function envOf(e: TestEnv, extra: Record<string, string> = {}): Record<string, string> {
  return {
    HOME: e.root, XDG_CONFIG_HOME: `${e.root}/.config`,
    AGMUX_HUB_BIN: e.hubBin, AGMUX_WRAP_BIN: e.wrapBin, PATH: process.env.PATH ?? "", ...extra,
  };
}

function hubUrl(e: TestEnv): string {
  return `http://127.0.0.1:${fs.readFileSync(path.join(e.stateDir, "hub.port"), "utf8").trim()}`;
}

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`GET ${url} → ${r.status}`);
  return (await r.json()) as T;
}

async function postIngest(url: string, ev: unknown): Promise<void> {
  const r = await fetch(`${url}/ingest`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(ev),
  });
  if (r.status !== 202) throw new Error(`POST /ingest → ${r.status}: ${await r.text()}`);
}

// The sandbox-side CLI: HOME comes from the fake, so these shims must not pin it.
function writeSandboxShims(dir: string): string {
  const hub = path.join(dir, "sbx-agmux-hub");
  const cli = path.join(dir, "sbx-agmux");
  fs.writeFileSync(hub, `#!/bin/sh\nexec bun ${path.join(repo, "packages/hub/bin/agmux-hub.ts")} "$@"\n`);
  fs.writeFileSync(cli, [
    "#!/bin/sh",
    'export XDG_CONFIG_HOME="$HOME/.config"',
    `export AGMUX_HUB_BIN=${JSON.stringify(hub)}`,
    "unset AGMUX_WRAP_BIN",
    `exec bun ${path.join(repo, "packages/cli/bin/agmux.ts")} "$@"`,
    "",
  ].join("\n"));
  fs.chmodSync(hub, 0o755);
  fs.chmodSync(cli, 0o755);
  return cli;
}

// One tmux call on a test server. Never the ambient server: always -S, always -f /dev/null.
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

interface RemoteRow { session_id: string; name?: string | null; remote_tmux?: unknown }
interface OuterPane { window: string; name: string; pane: string; id: string; mode: string }

let mac: TestEnv;
let fakeDir = "";
let innerSock = "";
let outerSock = "";
let innerWindow = "";
let innerPane = "";
let sid = "";
let macWindow = "";
let attachEnv: Record<string, string> = {};
let controlClient: ReturnType<typeof Bun.spawn> | null = null;
const NAME = "agent-x";

function calls(): string[] {
  try { return lines(fs.readFileSync(path.join(fakeDir, "calls.log"), "utf8")); } catch { return []; }
}

function outerPanes(): OuterPane[] {
  const r = tmux(outerSock, ["list-panes", "-a", "-F",
    "#{window_id}\t#{window_name}\t#{pane_id}\t#{@agmux_session_id}\t#{@agmux_attach_mode}"]);
  if (!r.ok) return [];
  return lines(r.out).map((l) => {
    const [window = "", name = "", pane = "", id = "", mode = ""] = l.split("\t");
    return { window, name, pane, id, mode };
  });
}

function remotePanes(mode?: string): OuterPane[] {
  return outerPanes().filter((p) => p.id === sid && (mode === undefined || p.mode === mode));
}

function innerSessions(): string[] {
  const r = tmux(innerSock, ["list-sessions", "-F", "#{session_name}"]);
  return r.ok ? lines(r.out) : [];
}

function viewName(outerPane: string): string {
  return `agmux-view-${sid.slice(0, 8)}-p${outerPane.slice(1)}`;
}

async function attach(mode: "view" | "full"): Promise<{ code: number; err: string }> {
  const r = await $`${mac.cliBin} attach ${sid} --placement new-window --mode ${mode}`.env(attachEnv).nothrow().quiet();
  return { code: r.exitCode, err: r.stderr.toString() };
}

beforeAll(async () => {
  if (!hasTmux) return;
  mac = makeTestEnv();
  fakeDir = path.join(mac.root, "fake-os");
  fs.mkdirSync(fakeDir);
  const box1 = makeTestEnv();
  fs.symlinkSync(box1.root, path.join(fakeDir, "box1"));
  const sbxCli = writeSandboxShims(fakeDir);
  fs.writeFileSync(path.join(fakeDir, "list.json"), JSON.stringify({ next_page_token: "", sandboxes: [{ name: "box1" }] }));
  innerSock = path.join(mac.root, "inner.sock");
  outerSock = path.join(mac.root, "outer.sock");

  // The sandbox's tmux: the agent's session `work`.
  tmuxOut(innerSock, ["new-session", "-d", "-s", "work", "-x", "80", "-y", "24", "sleep 600"],
    { PATH: process.env.PATH ?? "", HOME: box1.root });
  [innerWindow = "", innerPane = ""] = tmuxOut(innerSock, ["display-message", "-p", "-t", "work", "#{window_id}\t#{pane_id}"]).split("\t");

  // The sandbox's native session, stamped with the host the Mac expects, on the inner server.
  // pid: a live process, so no liveness sweep can end the session under the test.
  await warmHub(box1.cliBin, envOf(box1));
  const box1$ = hubUrl(box1);
  const identity = { agent_kind: "claude", native_session_id: `nat-${crypto.randomUUID()}` };
  const ts = new Date().toISOString();
  const envelope = { ts, identity, version: 1, host: "gw/box1" };
  await postIngest(box1$, {
    ...envelope, event_id: crypto.randomUUID(), kind: "session.registered",
    payload: { ...identity, pid: process.pid, cwd: "/tmp", tmux_session: "work", tmux_window: innerWindow,
      tmux_pane: innerPane, tmux_socket: innerSock, profile: null, agent_version: null, parent: null },
  });
  await postIngest(box1$, {
    ...envelope, event_id: crypto.randomUUID(), kind: "session.metadata", payload: { name: { name: NAME, source: "agent" } },
  });
  await postIngest(box1$, { ...envelope, event_id: crypto.randomUUID(), kind: "turn.ended", payload: {} });
  sid = (await getJson<{ sessions: { session_id: string; native_session_id: string | null }[] }>(`${box1$}/sessions`))
    .sessions.find((s) => s.native_session_id === identity.native_session_id)!.session_id;

  fs.appendFileSync(mac.configPath, `
[[remote]]
name = "t"
gateway = "gw"
interval = 0.2
openshell_bin = ${JSON.stringify(fakeOpenshell)}
agmux_bin = ${JSON.stringify(sbxCli)}
`);
  const macEnv = envOf(mac, { FAKE_OS_DIR: fakeDir });
  await warmHub(mac.cliBin, macEnv);
  const mac$ = hubUrl(mac);
  await waitFor(async () => {
    const r = await $`${mac.cliBin} ls --remote`.env(macEnv).nothrow().quiet();
    return r.exitCode === 0 && r.stdout.toString().includes(sid.slice(0, 8));
  }, 15_000);
  // The name and the coords travel with later events: wait until the row carries both.
  await waitFor(async () => {
    const { session } = await getJson<{ session: RemoteRow }>(`${mac$}/sessions/${sid}`);
    return session.name === NAME && session.remote_tmux != null;
  }, 10_000);

  // The Mac's tmux. Its panes inherit this server's environment, not the test's:
  // the pane process (AGMUX_BIN, the shim pinning the Mac HOME) must find the hub
  // and the fake openshell from here. `screen`: a terminfo entry every box has.
  const outerEnv = { ...macEnv, AGMUX_BIN: mac.cliBin, TERM: "screen" };
  tmuxOut(outerSock, ["new-session", "-d", "-s", "mac", "-x", "120", "-y", "40", "sleep 600",
    ";", "set-option", "-g", "default-terminal", "screen"], outerEnv);
  const [serverPid = "", window = "", macPane = ""] =
    tmuxOut(outerSock, ["display-message", "-p", "-t", "mac", "#{pid}\t#{window_id}\t#{pane_id}"]).split("\t");
  macWindow = window;
  // A client on `mac` stands in for the user's terminal: switch-client needs one.
  controlClient = Bun.spawn(["tmux", "-u", "-f", "/dev/null", "-S", outerSock, "-C", "attach-session", "-t", "mac"], {
    env: outerEnv, stdin: "pipe", stdout: "ignore", stderr: "ignore",
  });
  await waitFor(() => lines(tmux(outerSock, ["list-clients", "-F", "#{client_name}"]).out).length === 1, STEP_MS);

  // `agmux attach` as run from the `mac` pane.
  attachEnv = { ...macEnv, AGMUX_BIN: mac.cliBin, TMUX: `${outerSock},${serverPid},0`, TMUX_PANE: macPane };
}, 60_000);

afterAll(() => {
  if (!hasTmux) return;
  try { controlClient?.kill(); } catch { /* gone */ }
  for (const sock of [outerSock, innerSock]) {
    if (sock) tmux(sock, ["kill-server"]);
  }
  cleanupAllTestEnvs();
});

describe.skipIf(!hasTmux)("remote attach through a fake openshell and two tmux servers", () => {
  let viewPane = "";
  let viewWindow = "";

  test("view attach builds the remote view", async () => {
    const r = await attach("view");
    expect(r).toEqual({ code: 0, err: "" });
    await waitFor(() => remotePanes("view").length === 1, STEP_MS);
    const [p] = remotePanes("view");
    expect(p!.name).toBe(`⇄ ${NAME}`);
    viewPane = p!.pane;
    viewWindow = p!.window;

    // The script builds the view in steps (new-session, link-window, kill-window ^),
    // then attaches: wait for the end state, work's window alone with one client.
    const view = viewName(viewPane);
    const windows = () => {
      const r = tmux(innerSock, ["list-windows", "-t", `=${view}`, "-F", "#{window_id}"]);
      return r.ok ? lines(r.out) : [];
    };
    const viewClients = () => lines(tmux(innerSock, ["list-clients", "-t", `=${view}`, "-F", "#{client_name}"]).out).length;
    await waitFor(() => windows().join() === innerWindow && viewClients() === 1, STEP_MS);
    expect(windows()).toEqual([innerWindow]);
    expect(calls().some((l) => l.startsWith(["-g", "gw", "sandbox", "exec", "-n", "box1", "--tty", "--", "sh", "-c"].join("\t"))))
      .toBe(true);
  }, 15_000);

  test("second attach switches instead of duplicating", async () => {
    tmuxOut(outerSock, ["select-window", "-t", macWindow]);
    const r = await attach("view");
    expect(r).toEqual({ code: 0, err: "" });
    expect(remotePanes()).toHaveLength(1);
    expect(tmuxOut(outerSock, ["display-message", "-p", "#{window_id}"])).toBe(viewWindow);
  }, 15_000);

  test("a mouse click in the view selects the other remote pane", async () => {
    // The agent opened a second pane next to itself (a linked window: the view shows it too).
    const second = tmuxOut(innerSock, ["split-window", "-h", "-d", "-t", innerWindow, "-P", "-F", "#{pane_id}", "sleep 600"]);
    const active = () => tmuxOut(innerSock, ["display-message", "-p", "-t", innerWindow, "#{pane_id}"]);
    expect(active()).toBe(innerPane);
    const [left = "0"] = tmuxOut(innerSock, ["display-message", "-p", "-t", second, "#{pane_left}"]).split("\t");
    // An SGR mouse click typed into the local view pane reaches the sandbox's tmux client;
    // SGR coordinates are 1-based, and the view has no status line.
    const x = Number(left) + 3;
    tmuxOut(outerSock, ["send-keys", "-t", viewPane, "-l", `\x1b[<0;${x};3M\x1b[<0;${x};3m`]);
    await waitFor(() => active() === second, STEP_MS);
    tmuxOut(innerSock, ["kill-pane", "-t", second]);
  }, 15_000);

  test("closing the local window reaps the view", async () => {
    const view = viewName(viewPane);
    tmuxOut(outerSock, ["kill-window", "-t", viewWindow]);
    await waitFor(() => !innerSessions().includes(view), STEP_MS);
    const reap = (l: string) => l.includes(["--no-tty", "--", "sh", "-c"].join("\t")) && l.endsWith(`\tagmux\tp${viewPane.slice(1)}`);
    await waitFor(() => calls().some(reap), STEP_MS);
    // The agent's own session is untouched.
    expect(innerSessions()).toContain("work");
  }, 15_000);

  test("full attach adds a client on the agent session", async () => {
    const clients = () => lines(tmux(innerSock, ["list-clients", "-t", "work", "-F", "#{client_name}"]).out).length;
    const before = clients();
    const r = await attach("full");
    expect(r).toEqual({ code: 0, err: "" });
    await waitFor(() => clients() === before + 1, STEP_MS);
    expect(remotePanes("full")).toHaveLength(1);
  }, 15_000);
});
