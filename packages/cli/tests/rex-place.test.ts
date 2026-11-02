import { test, expect, spyOn } from "bun:test";
import { holdOnFailure } from "../src/tmux-place.ts";
import {
  rexCurrentPane, rexSplitPane, rexNewWindow, rexNewSession, rexSwitchClient, rexNewLabelledTab, findLabelledBlock,
  findLabelledBlockAnywhere,
} from "../src/rex-place.ts";
import { placementOps } from "../src/mux-ops.ts";
import { runCmd } from "../src/run.ts";
import { fakeRex } from "./helpers/fake-rex.ts";

const S = "session:s1";
const W = "window:w1";
const B = "block:b1";
const G = ["--autostart=false", "-S", "unix:///x", "--timeout", "10s"];
const hold = holdOnFailure(["agmux-wrap", "--x"]);

test("rexSplitPane: argv, env via env(1), hold wrapper, ids from --json", async () => {
  const exec = fakeRex({
    [`split -s ${S} -b ${B} --json -c /w -- env K=V ${hold.join(" ")}`]: { stdout: JSON.stringify({ anchor_id: B, block_ids: ["block:new"], split_ids: [], revision: 2 }) },
    [`block inspect block:new -s ${S} --json`]: { stdout: JSON.stringify({ block: { window_id: W } }) },
  });
  const c = await rexSplitPane({ targetPane: B, session: S, cmd: ["agmux-wrap", "--x"], env: { K: "V" }, detach: false, cwd: "/w", socket: "unix:///x" }, exec);
  expect(c).toEqual({ session: S, window: W, pane: "block:new", socket: "unix:///x" });
  expect(exec.calls[0]).toEqual([...G, "split", "-s", S, "-b", B, "--json", "-c", "/w", "--", "env", "K=V", ...hold]);
  expect(exec.calls[0]).not.toContain("--shell=none");
});

test("rexSplitPane detach adds --focus=false", async () => {
  const exec = fakeRex({});
  await rexSplitPane({ targetPane: B, session: S, cmd: ["c"], env: {}, detach: true, socket: null }, exec).catch(() => {});
  expect(exec.calls[0]).toContain("--focus=false");
  expect(exec.calls[0]).not.toContain("-S");
});

test("rexNewWindow honours cwd and uses the session id", async () => {
  const exec = fakeRex({
    "ls --json": { stdout: JSON.stringify({ sessions: [{ session_id: S, label: "lbl" }] }) },
    [`window new -s ${S} win --json -c /w -- ${hold.join(" ")}`]: { stdout: JSON.stringify({ window_id: W, block_ids: [B], revision: 1 }) },
  });
  const c = await rexNewWindow({ sessionName: S, windowName: "win", cmd: ["agmux-wrap", "--x"], env: {}, detach: false, cwd: "/w", socket: "unix:///x" }, exec);
  expect(c).toEqual({ session: S, window: W, pane: B, socket: "unix:///x" });
});

test("rexNewWindow with a label override resolves the label, or creates that session", async () => {
  const exists = fakeRex({
    "ls --json": { stdout: JSON.stringify({ sessions: [{ session_id: S, label: "agmux" }] }) },
    [`window new -s ${S} win --json --focus=false -- ${hold.join(" ")}`]: { stdout: JSON.stringify({ window_id: W, block_ids: [B], revision: 1 }) },
  });
  const a = { sessionName: "agmux", windowName: "win", cmd: ["agmux-wrap", "--x"], env: {}, detach: true, socket: null };
  expect((await rexNewWindow(a, exists)).session).toBe(S);

  const absent = fakeRex({
    "ls --json": { stdout: JSON.stringify({ sessions: [] }) },
    [`new agmux --window win --json -- ${hold.join(" ")}`]: { stdout: JSON.stringify({ session_id: "session:n", initial_windows: [{ window_id: W, block_ids: [B] }] }) },
  });
  expect(await rexNewWindow(a, absent)).toEqual({ session: "session:n", window: W, pane: B, socket: null });
});

test("rexNewSession returns ids from .session_id and .initial_windows[0]", async () => {
  const exec = fakeRex({
    "ls --json": { stdout: JSON.stringify({ sessions: [] }) },
    [`new agmux-x --window win --json -- env A=1 ${hold.join(" ")}`]: { stdout: JSON.stringify({ session_id: "session:n", initial_windows: [{ window_id: W, block_ids: [B], revision: 1 }] }) },
  });
  const c = await rexNewSession({ sessionName: "agmux-x", windowName: "win", cmd: ["agmux-wrap", "--x"], env: { A: "1" } }, exec);
  expect(c).toEqual({ session: "session:n", window: W, pane: B, socket: null });
  const dup = fakeRex({ "ls --json": { stdout: JSON.stringify({ sessions: [{ session_id: S, label: "agmux-x" }] }) } });
  await expect(rexNewSession({ sessionName: "agmux-x", windowName: "w", cmd: ["c"], env: {} }, dup)).rejects.toThrow("already exists");
});

test("rexSwitchClient focuses the window's block and switches the app", async () => {
  const app = "client:app";
  const exec = fakeRex({
    "session inspect session:aa --json": { stdout: JSON.stringify({ windows: [{ window_id: "window:zz", focused_block_id: "block:no" }, { window_id: "window:bb", focused_block_id: "block:cc" }] }) },
    [`api call -s session:aa session.focus_block ${JSON.stringify({ session_id: "session:aa", block_id: "block:cc" })}`]: { stdout: "{}" },
    "client ls --json": { stdout: JSON.stringify({ clients: [{ client_id: app, info: { kind: "app" } }] }) },
    [`-C ${app} do session.select -s session:aa session_id=session:aa window_id=window:bb`]: {},
  });
  await rexSwitchClient("session:aa:window:bb", "unix:///x", null, exec);
  for (const c of exec.calls) expect(c.slice(0, 3)).toEqual(["--autostart=false", "-S", "unix:///x"]);
  expect(exec.calls.at(-1)).toContain("session.select");
  await expect(rexSwitchClient("nonsense", null, null, exec)).rejects.toThrow();
});

test("rexSwitchClient does not fail a placement that succeeded when no app can switch", async () => {
  const exec = fakeRex({
    "session inspect session:aa --json": { stdout: JSON.stringify({ windows: [{ window_id: "window:bb", focused_block_id: "block:cc" }] }) },
    [`api call -s session:aa session.focus_block ${JSON.stringify({ session_id: "session:aa", block_id: "block:cc" })}`]: { stdout: "{}" },
    "client ls --json": { stdout: JSON.stringify({ clients: [] }) },
  });
  await rexSwitchClient("session:aa:window:bb", null, null, exec);
});

test("rexSwitchClient without a block to focus reports it", async () => {
  await expect(rexSwitchClient("session:aa:window:bb", null, null, fakeRex({}))).rejects.toThrow("rex focus");
});

test("rexNewLabelledTab and findLabelledBlock", async () => {
  const exec = fakeRex({
    [`run -s ${S} --label agmux:tmux:h --json -- env K=V tmux attach`]: { stdout: JSON.stringify({ window_id: W, block_ids: [B], revision: 1 }) },
    [`block ls -s ${S} --json`]: { stdout: JSON.stringify({ blocks: [{ block_id: "block:o", label: "shell" }, { block_id: B, label: "agmux:tmux:h" }] }) },
  });
  const c = await rexNewLabelledTab({ session: S, label: "agmux:tmux:h", cmd: ["tmux", "attach"], env: { K: "V" }, socket: "unix:///x" }, exec);
  expect(c).toEqual({ session: S, window: W, pane: B, socket: "unix:///x" });
  expect(await findLabelledBlock(S, "agmux:tmux:h", "unix:///x", exec)).toBe(B);
  expect(await findLabelledBlock(S, "nope", "unix:///x", exec)).toBeNull();
});

const inspect = {
  windows: [
    { window_id: "window:other", focused_block_id: "block:zz", layers: [{ kind: "tiled", blocks: [{ block_id: "block:zz" }] }] },
    { window_id: W, focused_block_id: "block:float", layers: [
      { kind: "floating", blocks: [{ block_id: "block:float" }] },
      { kind: "tiled", blocks: [{ block_id: "block:t1" }, { block_id: "block:t2" }] },
    ] },
  ],
};
const popupEnv = { REX_SESSION: S, REX_BLOCK: "block:float", REX_SERVER: "unix:///x" };
const popupScript = {
  [`block inspect block:float -s ${S} --json`]: { stdout: JSON.stringify({ block: { window_id: W } }) },
  [`session inspect ${S} --json`]: { stdout: JSON.stringify(inspect) },
};

test("rexCurrentPane in popup returns the tiled block, not REX_BLOCK", async () => {
  const c = await rexCurrentPane(popupEnv, true, fakeRex(popupScript));
  expect(c).toEqual({ session: S, window: W, pane: "block:t1", socket: "unix:///x" });
});

test("rexCurrentPane in popup prefers AGMUX_REX_ORIGIN_BLOCK", async () => {
  const exec = fakeRex({ ...popupScript, [`block inspect block:t2 -s ${S} --json`]: { stdout: JSON.stringify({ block: { window_id: W } }) } });
  const c = await rexCurrentPane({ ...popupEnv, AGMUX_REX_ORIGIN_BLOCK: "block:t2" }, true, exec);
  expect(c).toEqual({ session: S, window: W, pane: "block:t2", socket: "unix:///x" });
});

test("rexCurrentPane in popup with no tiled block returns null", async () => {
  const none = { windows: [{ window_id: W, layers: [{ kind: "floating", blocks: [{ block_id: "block:float" }] }] }] };
  const exec = fakeRex({ ...popupScript, [`session inspect ${S} --json`]: { stdout: JSON.stringify(none) } });
  expect(await rexCurrentPane(popupEnv, true, exec)).toBeNull();
});

test("rexCurrentPane outside a popup uses REX_BLOCK", async () => {
  const exec = fakeRex({ "whoami --json": { stdout: JSON.stringify({ session_id: S, window_id: W, block_id: "block:me" }) } });
  const c = await rexCurrentPane({ REX_SESSION: S, REX_BLOCK: "block:me" }, false, exec);
  expect(c).toEqual({ session: S, window: W, pane: "block:me", socket: null });
});

test("placementOps' switchClient in a popup picks the app by the tiled block, on the Rex server", async () => {
  const app = "client:app";
  const exec = fakeRex({
    ...popupScript,
    [`api call -s ${S} session.focus_block ${JSON.stringify({ session_id: S, block_id: "block:zz" })}`]: { stdout: "{}" },
    "client ls --json": { stdout: JSON.stringify({ clients: [{ client_id: "client:other", info: { kind: "app" } }, { client_id: app, info: { kind: "app" } }] }) },
    "block inspect block:t1 --json": { stdout: JSON.stringify({ block: { owner: app } }) },
    [`-C ${app} do session.select -s ${S} session_id=${S} window_id=window:other`]: {},
  });
  await placementOps(popupEnv, true, exec).switchClient(`${S}:window:other`, null);
  expect(exec.calls.flat()).toContain("session.select");
  for (const c of exec.calls) expect(c.slice(0, 3)).toEqual(["--autostart=false", "-S", "unix:///x"]);
});

test("placementOps picks rex only for detectMux rex", () => {
  expect(placementOps({ REX_BLOCK: "b" }).kind).toBe("rex");
  expect(placementOps({ TMUX: "/s,1,0", REX_BLOCK: "b" }).kind).toBe("tmux");
  expect(placementOps({}).kind).toBe("tmux");
});

test("runWithPlacement in Rex prints the block id and never calls tmux", async () => {
  const calls: string[] = [];
  const ops = {
    kind: "rex" as const,
    currentPane: async () => ({ session: S, window: W, pane: "block:me", socket: null }),
    splitPane: async (a: { targetPane: string }) => { calls.push(`split ${a.targetPane}`); return { session: S, window: W, pane: "block:new", socket: null }; },
    hasSession: async () => true,
    newWindow: async () => ({ session: S, window: W, pane: "block:win", socket: null }),
    newSession: async () => ({ session: S, window: W, pane: "block:sess", socket: null }),
    switchClient: async () => {},
  };
  const logs: string[] = [];
  const orig = console.log;
  console.log = (l: string) => { logs.push(String(l)); };
  try {
    const opts = { kind: "inline" as const, agent_kind: "claude" as const, command: "claude", args: [], hubUrl: "http://h", wrapBin: "w", placement: "new-pane" as const, detach: false };
    expect(await runCmd(opts, "agmux", undefined, ops)).toBe(0);
  } finally { console.log = orig; }
  expect(calls).toEqual(["split block:me"]);
  expect(logs.join("\n")).toContain("block:new");
});

test("rexNewSession: a failed label rename still returns the running block's coords", async () => {
  const exec = fakeRex({
    "ls --json": { stdout: JSON.stringify({ sessions: [] }) },
    [`new agmux-x --window win --json -- ${hold.join(" ")}`]: { stdout: JSON.stringify({ session_id: "session:n", initial_windows: [{ window_id: W, block_ids: [B] }] }) },
    [`block rename ${B} lbl -s session:n`]: { code: 1 },
  });
  const warn = spyOn(console, "error").mockImplementation(() => {});
  try {
    const c = await rexNewSession({ sessionName: "agmux-x", windowName: "win", cmd: ["agmux-wrap", "--x"], env: {}, label: "lbl" }, exec);
    expect(c).toEqual({ session: "session:n", window: W, pane: B, socket: null });
    expect(warn.mock.calls.flat().join("\n")).toContain("rex block rename failed");
  } finally { warn.mockRestore(); }
});

test("findLabelledBlockAnywhere looks in the caller's session first, then the others", async () => {
  const label = { blocks: [{ block_id: "block:hit", label: "L" }] };
  const none = { blocks: [{ block_id: "block:o", label: "shell" }] };
  const sessions = { sessions: [{ session_id: "session:a" }, { session_id: S }, { session_id: "session:b" }, { session_id: "session:c" }] };
  const own = fakeRex({ [`block ls -s ${S} --json`]: { stdout: JSON.stringify(label) } });
  expect(await findLabelledBlockAnywhere(S, "L", "unix:///x", own)).toEqual({ session: S, pane: "block:hit" });
  expect(own.calls.length).toBe(1);

  const other = fakeRex({
    [`block ls -s ${S} --json`]: { stdout: JSON.stringify(none) },
    "ls --json": { stdout: JSON.stringify(sessions) },
    "block ls -s session:a --json": { code: 3 }, // gone since `ls`: the search carries on
    "block ls -s session:b --json": { stdout: JSON.stringify(label) },
  });
  expect(await findLabelledBlockAnywhere(S, "L", "unix:///x", other)).toEqual({ session: "session:b", pane: "block:hit" });
  expect(other.calls.map((c) => c.at(-2)).filter((a) => a === S).length).toBe(1);
  expect(other.calls.some((c) => c.join(" ").includes("session:c"))).toBe(false);
});

test("findLabelledBlockAnywhere: nothing found, or no session list, is no match", async () => {
  const none = { [`block ls -s ${S} --json`]: { stdout: JSON.stringify({ blocks: [] }) } };
  expect(await findLabelledBlockAnywhere(S, "L", null, fakeRex(none))).toBeNull();
  expect(await findLabelledBlockAnywhere(S, "L", null, fakeRex({ ...none, "ls --json": { stdout: JSON.stringify({ sessions: [{ session_id: S }] }) } }))).toBeNull();
});
