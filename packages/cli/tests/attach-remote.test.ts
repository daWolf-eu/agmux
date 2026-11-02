import { describe, expect, test } from "bun:test";
import type { SessionRow } from "@agmux/protocol";
import type { AttachCtx } from "@agmux/tui";
import {
  attachRemote, findRemotePane, remotePaneCmd, remoteWindowName, type AttachRemoteDeps,
} from "../src/attach-remote.ts";
import { attachSettingsFrom } from "../src/attach-place.ts";
import { holdOnFailure } from "../src/tmux-place.ts";
import { fakeRex } from "./helpers/fake-rex.ts";

const ID = "11111111-2222-4333-8444-555555555555";
const SETTINGS = attachSettingsFrom({ terminal: { newTab: ["term", "--tab", "-e", "{cmd}"] }, remote: {} }, "/bin/agmux");
const IN_TMUX: AttachCtx = { inMux: true, popup: false, terminalWindow: false, terminalTab: true };
const NO_TMUX: AttachCtx = { ...IN_TMUX, inMux: false };

function remoteRow(over: Partial<SessionRow> = {}): SessionRow {
  return {
    tmux_server: null, mux: null, mux_label: null,
    session_id: ID, agent_kind: "claude", profile: null, native_session_id: null,
    command: "claude", args: [], env_overrides: {}, cwd: "/w", pid: null,
    tmux_session: null, tmux_window: null, tmux_pane: null, tmux_socket: null,
    host: "gw/box1", project: null, parent_session_id: null,
    start_ts: "2026-10-21T10:00:00.000Z", last_heartbeat_ts: null,
    end_ts: null, exit_code: null, signal: null, status: "idle", origin: "native",
    remote: true, remote_tmux: { session: "work", window: "@0", pane: "%0", socket: null }, remote_pid: 7,
    ...over,
  };
}

function recorder(listing = "") {
  const tmux: string[][] = [];
  const placed: { kind: string; args: Record<string, unknown> }[] = [];
  const spawned: string[][] = [];
  const coords = (window: string) => ({ session: "mac", window, pane: "%20", socket: null });
  const deps: AttachRemoteDeps = {
    mux: "tmux",
    runTmux: async (a) => { tmux.push(a); },
    listPanes: async () => listing,
    currentPane: async () => ({ session: "mac", window: "@1", pane: "%2", socket: null }),
    splitPane: (async (a: Record<string, unknown>) => { placed.push({ kind: "splitPane", args: a }); return coords("@1"); }) as never,
    newWindow: (async (a: Record<string, unknown>) => { placed.push({ kind: "newWindow", args: a }); return coords("@9"); }) as never,
    newSession: (async (a: Record<string, unknown>) => { placed.push({ kind: "newSession", args: a }); return { ...coords("@0"), session: "agmux-11111111" }; }) as never,
    switchClient: async (t) => { tmux.push(["switch-client", "-t", t]); },
    spawnDetached: (argv) => { spawned.push(argv); },
  };
  return { deps, tmux, placed, spawned };
}

describe("remoteWindowName", () => {
  test("window name escapes formats and caps width", () => {
    expect(remoteWindowName("⇄ {title}", remoteRow({ name: "#(rm -rf ~)" }))).toBe("⇄ ##(rm -rf ~)");
    expect(remoteWindowName("⇄ {title}", remoteRow({ name: "a\u001b[31mb" }))).toBe("⇄ ab");
    const long = remoteWindowName("⇄ {title}", remoteRow({ name: "x".repeat(200) }));
    expect(long).toBe(`⇄ ${"x".repeat(40)}`);
    expect(Bun.stringWidth(long)).toBe(Bun.stringWidth("⇄ ") + 40);
    expect(remoteWindowName("⇄ {title}", remoteRow({ name: null }))).toBe("⇄ 11111111");
  });

  test("a trailing `;` is escaped so tmux does not end the command there", () => {
    expect(remoteWindowName("{title}", remoteRow({ name: "x;" }))).toBe("x\\;");
  });

  test("wide characters are cut by display width", () => {
    const t = remoteWindowName("{title}", remoteRow({ name: "界".repeat(30) }));
    expect(Bun.stringWidth(t)).toBe(40);
  });
});

test("remotePaneCmd: the Mac's agmux runs the pane process", () => {
  expect(remotePaneCmd("/bin/agmux", ID, "view", "M-d")).toEqual(
    ["/bin/agmux", "attach", ID, "--remote-client", "--mode", "view", "--detach-key", "M-d"]);
});

describe("findRemotePane", () => {
  const listing = [
    "mac\t@1\t%2\t\t",
    `mac\t@4\t%9\t${ID}\tview`,
    `other\t@5\t%11\t${ID}\tfull`,
  ].join("\n");

  test("matches session id and mode", async () => {
    expect(await findRemotePane(ID, "view", async () => listing)).toEqual({ session: "mac", window: "@4", pane: "%9" });
    expect(await findRemotePane(ID, "full", async () => listing)).toEqual({ session: "other", window: "@5", pane: "%11" });
    expect(await findRemotePane("22222222-2222-4333-8444-555555555555", "view", async () => listing)).toBeNull();
  });

  test("a failing listing is no match", async () => {
    expect(await findRemotePane(ID, "view", async () => { throw new Error("no server"); })).toBeNull();
  });
});

describe("attachRemote", () => {
  const env = (ctx: AttachCtx) => ({ ctx, settings: SETTINGS });

  test("dedup per mode", async () => {
    const r = recorder(`mac\t@4\t%9\t${ID}\tview`);
    expect(await attachRemote(remoteRow(), undefined, env(IN_TMUX), r.deps)).toBeNull();
    expect(r.tmux).toEqual([["switch-client", "-t", "mac:@4"], ["select-pane", "-t", "%9"]]);
    expect(r.placed).toEqual([]);

    const f = recorder(`mac\t@4\t%9\t${ID}\tview`);
    await attachRemote(remoteRow(), { placement: "new-window", mode: "full" }, env(IN_TMUX), f.deps);
    expect(f.placed.map((p) => p.kind)).toEqual(["newWindow"]);
  });

  test("in tmux with no request: new window in view mode, named, auto-rename off", async () => {
    const r = recorder();
    expect(await attachRemote(remoteRow({ name: "fix #1" }), undefined, env(IN_TMUX), r.deps)).toBeNull();
    expect(r.placed).toHaveLength(1);
    const a = r.placed[0]!.args;
    expect(r.placed[0]!.kind).toBe("newWindow");
    expect(a.sessionName).toBe("mac");
    expect(a.windowName).toBe("⇄ fix ##1");
    expect(a.cmd).toEqual(remotePaneCmd("/bin/agmux", ID, "view", "M-d"));
    expect(r.tmux).toEqual([["set-option", "-w", "-t", "@9", "automatic-rename", "off"]]);
  });

  test("outside tmux with no request: inline handoff in full mode", async () => {
    const r = recorder();
    const h = await attachRemote(remoteRow(), undefined, env(NO_TMUX), r.deps);
    expect(h).toEqual({ argv: remotePaneCmd("/bin/agmux", ID, "full", "M-d") });
    expect(r.tmux).toEqual([]);
  });

  test("req.mode wins", async () => {
    const r = recorder();
    await attachRemote(remoteRow(), { placement: "new-window", mode: "full" }, env(IN_TMUX), r.deps);
    expect(r.placed[0]!.args.cmd).toContain("full");
    const h = await attachRemote(remoteRow(), { placement: "inline", mode: "view" }, env(NO_TMUX), recorder().deps);
    expect(h!.argv).toEqual(remotePaneCmd("/bin/agmux", ID, "view", "M-d"));
  });

  test("peek is planned", async () => {
    await expect(attachRemote(remoteRow(), { placement: "peek" }, env(IN_TMUX), recorder().deps)).rejects.toThrow("peek: planned");
  });

  test("new-pane splits the caller's pane without renaming its window", async () => {
    const r = recorder();
    await attachRemote(remoteRow(), { placement: "new-pane" }, env(IN_TMUX), r.deps);
    expect(r.placed[0]!.kind).toBe("splitPane");
    expect(r.placed[0]!.args.targetPane).toBe("%2");
    expect(r.tmux).toEqual([]);
  });

  test("new-session: named session and window, then the client switches", async () => {
    const r = recorder();
    await attachRemote(remoteRow(), { placement: "new-session" }, env(IN_TMUX), r.deps);
    expect(r.placed[0]!.kind).toBe("newSession");
    expect(r.placed[0]!.args.sessionName).toBe("agmux-11111111-view");
    expect(r.placed[0]!.args.windowName).toBe("⇄ 11111111");
    expect(r.tmux).toEqual([
      ["set-option", "-w", "-t", "@0", "automatic-rename", "off"],
      ["switch-client", "-t", "agmux-11111111:@0"],
    ]);
  });

  test("new-session: the session name carries the mode (view and full never collide)", async () => {
    const r = recorder();
    await attachRemote(remoteRow(), { placement: "new-session", mode: "full" }, env(IN_TMUX), r.deps);
    expect(r.placed[0]!.args.sessionName).toBe("agmux-11111111-full");
  });

  test("new-tab: the template runs `attach --placement inline --mode <m>`", async () => {
    const r = recorder();
    expect(await attachRemote(remoteRow(), { placement: "new-tab" }, env(IN_TMUX), r.deps)).toBeNull();
    expect(r.spawned).toEqual([["term", "--tab", "-e", "/bin/agmux", "attach", ID, "--placement", "inline", "--mode", "view"]]);
  });

  test("in a popup a placed window closes the popup", async () => {
    const r = recorder();
    expect(await attachRemote(remoteRow(), undefined, env({ ...IN_TMUX, popup: true }), r.deps)).toEqual({ argv: [] });
  });
});

describe("attachRemote in Rex", () => {
  const S = "session:s1";
  const W = "window:w1";
  const B = "block:b1";
  const LABEL = (m: string) => `agmux:remote:11111111:${m}`;
  const rexEnv = (ctx: Partial<AttachCtx> = {}) => ({ ctx: { ...IN_TMUX, ...ctx }, settings: SETTINGS });
  const cmd = (m: "view" | "full") => holdOnFailure(remotePaneCmd("/bin/agmux", ID, m, "M-d"));
  const run = (m: "view" | "full") => `run -s ${S} --label ${LABEL(m)} --json -- ${cmd(m).join(" ")}`;
  const noBlocks = { "block ls -s session:s1 --json": { stdout: JSON.stringify({ blocks: [{ block_id: B, label: "shell" }] }) } };
  const tab = { stdout: JSON.stringify({ window_id: "window:new", block_ids: ["block:new"], revision: 1 }) };

  function rexRec(script: Record<string, { code?: number; stdout?: string }>) {
    const r = recorder();
    const exec = fakeRex(script);
    const deps: AttachRemoteDeps = {
      ...r.deps, mux: "rex", rexExec: exec,
      currentPane: async () => ({ session: S, window: W, pane: B, socket: null }),
    };
    return { ...r, deps, exec };
  }

  test("in Rex the default mode is the configured mode (view), not full", async () => {
    const r = rexRec({ ...noBlocks, [run("view")]: tab });
    expect(await attachRemote(remoteRow(), undefined, rexEnv(), r.deps)).toBeNull();
    expect(r.exec.calls.some((c) => c.join(" ").includes(LABEL("view")))).toBe(true);
  });

  test("in Rex new-window opens a labelled tab running the remote client", async () => {
    const r = rexRec({ ...noBlocks, [run("view")]: tab });
    await attachRemote(remoteRow(), { placement: "new-window" }, rexEnv(), r.deps);
    expect(r.exec.calls.at(-1)!.slice(3).join(" ")).toBe(run("view"));
    expect(r.placed).toEqual([]);
    expect(r.tmux).toEqual([]);
  });

  test("in Rex new-pane splits the caller's block with the label", async () => {
    const split = `split -s ${S} -b ${B} --json --label ${LABEL("full")} -- ${cmd("full").join(" ")}`;
    const r = rexRec({ ...noBlocks, [split]: { stdout: JSON.stringify({ block_ids: ["block:new"] }) },
      [`block inspect block:new -s ${S} --json`]: { stdout: JSON.stringify({ block: { window_id: W } }) } });
    await attachRemote(remoteRow(), { placement: "new-pane", mode: "full" }, rexEnv(), r.deps);
    expect(r.exec.calls.some((c) => c.join(" ").endsWith(split))).toBe(true);
    expect(r.placed).toEqual([]);
  });

  test("in Rex new-session creates a session, labels the block, switches the app, never calls tmux", async () => {
    const name = "agmux-11111111-view";
    const r = rexRec({
      ...noBlocks,
      "ls --json": { stdout: JSON.stringify({ sessions: [] }) },
      [`new ${name} --window ⇄ 11111111 --json -- ${cmd("view").join(" ")}`]: {
        stdout: JSON.stringify({ session_id: "session:n", initial_windows: [{ window_id: "window:n", block_ids: ["block:n"] }] }) },
      [`block rename block:n ${LABEL("view")} -s session:n`]: {},
      "session inspect session:n --json": { stdout: JSON.stringify({ windows: [{ window_id: "window:n", focused_block_id: "block:n" }] }) },
      [`api call -s session:n session.focus_block ${JSON.stringify({ session_id: "session:n", block_id: "block:n" })}`]: { stdout: "{}" },
      "client ls --json": { stdout: JSON.stringify({ clients: [] }) },
    });
    await attachRemote(remoteRow(), { placement: "new-session" }, rexEnv(), r.deps);
    const all = r.exec.calls.map((c) => c.join(" "));
    expect(all.some((c) => c.includes("block rename block:n"))).toBe(true);
    expect(r.tmux).toEqual([]);
    expect(r.placed).toEqual([]);
  });

  test("in Rex an existing labelled block is focused, no second client starts", async () => {
    const focus = `api call -s ${S} session.focus_block ${JSON.stringify({ session_id: S, block_id: "block:old" })}`;
    const r = rexRec({
      "block ls -s session:s1 --json": { stdout: JSON.stringify({ blocks: [{ block_id: "block:old", label: LABEL("view") }] }) },
      [focus]: { stdout: "{}" },
      "client ls --json": { stdout: JSON.stringify({ clients: [{ client_id: "client:app", info: { kind: "app" } }] }) },
      [`-C client:app do session.select -s ${S} session_id=${S}`]: {},
    });
    expect(await attachRemote(remoteRow(), undefined, rexEnv(), r.deps)).toBeNull();
    const all = r.exec.calls.map((c) => c.join(" "));
    expect(all.some((c) => c.includes("session.focus_block"))).toBe(true);
    expect(all.some((c) => / run | split | new /.test(c))).toBe(false);
    expect(r.tmux).toEqual([]);
    expect(await attachRemote(remoteRow(), undefined, rexEnv({ popup: true }), r.deps)).toEqual({ argv: [] });
  });

  test("an existing labelled block is focused for inline and new-tab too; nothing starts", async () => {
    for (const placement of ["inline", "new-tab"] as const) {
      const r = rexRec({
        "block ls -s session:s1 --json": { stdout: JSON.stringify({ blocks: [{ block_id: "block:old", label: LABEL("view") }] }) },
        [`api call -s ${S} session.focus_block ${JSON.stringify({ session_id: S, block_id: "block:old" })}`]: { stdout: "{}" },
        "client ls --json": { stdout: JSON.stringify({ clients: [{ client_id: "client:app", info: { kind: "app" } }] }) },
        [`-C client:app do session.select -s ${S} session_id=${S}`]: {},
      });
      expect(await attachRemote(remoteRow(), { placement }, rexEnv(), r.deps)).toBeNull();
      expect(r.spawned).toEqual([]);
      expect(r.exec.calls.some((c) => c.join(" ").includes("session.focus_block"))).toBe(true);
    }
  });

  test("view and full of one session get different labels", async () => {
    const blocks = { "block ls -s session:s1 --json": { stdout: JSON.stringify({ blocks: [{ block_id: "block:v", label: LABEL("view") }] }) } };
    const r = rexRec({ ...blocks, [run("full")]: tab });
    await attachRemote(remoteRow(), { placement: "new-window", mode: "full" }, rexEnv(), r.deps);
    expect(r.exec.calls.at(-1)!.slice(3).join(" ")).toBe(run("full"));
  });

  test("inline in Rex returns the client argv and sets no label", async () => {
    const r = rexRec({});
    const h = await attachRemote(remoteRow(), { placement: "inline" }, rexEnv(), r.deps);
    expect(h).toEqual({ argv: remotePaneCmd("/bin/agmux", ID, "view", "M-d") });
    expect(r.exec.calls.every((c) => !c.join(" ").includes("--label"))).toBe(true);
    expect(r.tmux).toEqual([]);
  });
});
