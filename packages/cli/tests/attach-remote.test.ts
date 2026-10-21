import { describe, expect, test } from "bun:test";
import type { SessionRow } from "@agmux/protocol";
import type { AttachCtx } from "@agmux/tui";
import {
  attachRemote, findRemotePane, manualResumeCommand, remotePaneCmd, remoteWindowName, type AttachRemoteDeps,
} from "../src/attach-remote.ts";
import { attachSettingsFrom } from "../src/attach-place.ts";

const ID = "11111111-2222-4333-8444-555555555555";
const SPEC = { kind: "openshell" as const, gateway: "gw", target: "box1", bin: "openshell" };
const SETTINGS = attachSettingsFrom({ terminal: { newTab: ["term", "--tab", "-e", "{cmd}"] }, remote: {} }, "/bin/agmux");
const IN_TMUX: AttachCtx = { inTmux: true, popup: false, terminalWindow: false, terminalTab: true };
const NO_TMUX: AttachCtx = { ...IN_TMUX, inTmux: false };

function remoteRow(over: Partial<SessionRow> = {}): SessionRow {
  return {
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

test("manualResumeCommand: the transport's tty exec of the sandbox agmux", () => {
  expect(manualResumeCommand(SPEC, "agmux", ID)).toBe(`openshell -g gw sandbox exec -n box1 --tty -- agmux attach ${ID}`);
  expect(manualResumeCommand({ ...SPEC, bin: "/opt/open shell" }, "/x/agmux", ID))
    .toBe(`'/opt/open shell' -g gw sandbox exec -n box1 --tty -- /x/agmux attach ${ID}`);
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
