import { test, expect } from "bun:test";
import { planOpen, probeRow, openRexRow, openTmuxTab, tmuxTabLabel, rexUnreachableMessage, resumeTarget, type Presence } from "../src/open-row.ts";
import { rexPresence, pickClient, rexFocus } from "../src/rex-place.ts";
import { buildAttachCommands } from "../src/attach.ts";
import { holdOnFailure } from "../src/tmux-place.ts";
import { fakeRex } from "./helpers/fake-rex.ts";
import type { SessionRow } from "@agmux/protocol";

const S = "session:s1";
const W = "window:w1";
const B = "block:b1";
const SERVER = "unix:///row";
const APP = "client:app";

function rexRow(over: Partial<SessionRow> = {}): SessionRow {
  return {
    tmux_server: null, mux: "rex", mux_label: "work",
    session_id: "019f1898-8e0f-7000-ab55-07d09f673b59",
    agent_kind: "claude", profile: null, native_session_id: "n1",
    command: "claude", args: [], env_overrides: {}, cwd: "/tmp", pid: 1,
    tmux_session: S, tmux_window: W, tmux_pane: B, tmux_socket: SERVER,
    host: "h", project: null, parent_session_id: null,
    start_ts: "2026-06-30T12:54:38.836Z", last_heartbeat_ts: null,
    end_ts: null, exit_code: null, signal: null, status: "idle", origin: "native",
    ...over,
  };
}

const client = (id: string, kind = "app", state = "connected") =>
  ({ client_id: id, info: { kind }, connection_state: state });
const clientsOut = (...cs: unknown[]) => ({ stdout: JSON.stringify({ clients: cs }) });
const focusKey = (session = S, block = B) =>
  `api call -s ${session} session.focus_block ${JSON.stringify({ session_id: session, block_id: block })}`;
const selectKey = (id: string, session = S, window = W) =>
  `-C ${id} do session.select -s ${session} session_id=${session} window_id=${window}`;
const ownerOf = (block: string, owner: string) =>
  ({ [`block inspect ${block} --json`]: { stdout: JSON.stringify({ block: { block_id: block, owner } }) } });
const coords = { session: S, window: W, pane: B, socket: SERVER };
const verbs = (calls: string[][]) => calls.map((c) => c.find((a) => ["api", "client", "block", "do"].includes(a)));

test.each([
  // caller, row, live, presence, plan
  ["rex",  "rex",  true,  "present",     "focus-rex"],
  ["rex",  "tmux", true,  "present",     "tmux-tab"],
  ["tmux", "tmux", true,  "present",     "tmux-native"],
  [null,   "tmux", true,  "present",     "tmux-native"],
  ["tmux", "rex",  true,  "present",     "focus-rex"],
  [null,   "rex",  true,  "present",     "focus-rex"],
  ["rex",  "rex",  true,  "gone",        "resume"],
  ["rex",  "tmux", true,  "gone",        "resume"],
  ["tmux", "rex",  true,  "gone",        "resume"],
  ["rex",  "rex",  true,  "unreachable", "unreachable"],
  [null,   "rex",  true,  "unreachable", "unreachable"],
  ["rex",  "rex",  false, "gone",        "resume"],
] as const)("planOpen %s %s %s %s", (caller, row, live, presence, plan) => {
  expect(planOpen({ caller, row, live, presence })).toBe(plan);
});

test("planOpen: unreachable beats a closed row, the check comes first", () => {
  expect(planOpen({ caller: "tmux", row: "rex", live: false, presence: "unreachable" })).toBe("unreachable");
});

test.each([
  [0, "present"], [3, "gone"], [4, "unreachable"], [127, "unreachable"], [124, "unreachable"], [1, "unreachable"],
] as const)("rexPresence: exit %d is %s", async (code, want) => {
  const exec = fakeRex({ [`block inspect ${B} -s ${S} --json`]: { code } });
  expect(await rexPresence(rexRow(), exec)).toBe(want);
  expect(exec.calls[0]!.slice(0, 5)).toEqual(["--autostart=false", "-S", SERVER, "--timeout", "2s"]);
});

test("rexPresence on a row it can't address is never 'gone'", async () => {
  const exec = fakeRex({});
  expect(await rexPresence(rexRow({ tmux_session: null }), exec)).toBe("unreachable");
  expect(exec.calls).toEqual([]);
});

test("probeRow: a Rex row asks Rex, never tmux", async () => {
  const exec = fakeRex({ [`block inspect ${B} -s ${S} --json`]: { code: 3 } });
  const tmux = async () => { throw new Error("tmux probed for a Rex row"); };
  expect(await probeRow(rexRow(), tmux, exec)).toBe("gone");
});

test("probeRow: a tmux row maps onto present and gone, on its own socket", async () => {
  const row = rexRow({ mux: null, tmux_session: "work", tmux_socket: "/sock" });
  const seen: Array<[string, string | null]> = [];
  const exists = (v: boolean) => async (n: string, s: string | null) => { seen.push([n, s]); return v; };
  const exec = fakeRex({});
  expect(await probeRow(row, exists(true), exec) as Presence).toBe("present");
  expect(await probeRow(row, exists(false), exec) as Presence).toBe("gone");
  expect(seen).toEqual([["work", "/sock"], ["work", "/sock"]]);
  expect(exec.calls).toEqual([]);
});

test("pickClient: the caller block's owner, on the caller's server", async () => {
  const exec = fakeRex({ "client ls --json": clientsOut(client("client:a"), client(APP)), ...ownerOf("block:me", APP) });
  expect(await pickClient({ block: "block:me", server: SERVER }, SERVER, exec)).toBe(APP);
});

test("pickClient: a stale owner is not trusted, the sole app is used", async () => {
  const exec = fakeRex({ "client ls --json": clientsOut(client(APP), client("client:cli", "cli")), ...ownerOf("block:me", "client:dead") });
  expect(await pickClient({ block: "block:me", server: SERVER }, SERVER, exec)).toBe(APP);
});

test("pickClient: an owner that is a CLI client is not an app", async () => {
  const exec = fakeRex({ "client ls --json": clientsOut(client("client:cli", "cli"), client("client:a"), client("client:b")), ...ownerOf("block:me", "client:cli") });
  expect(await pickClient({ block: "block:me", server: SERVER }, SERVER, exec)).toBeNull();
});

test("pickClient: clients without a kind and lost apps don't count, an unknown state does", async () => {
  const exec = fakeRex({ "client ls --json": clientsOut(
    { client_id: "client:nokind", connection_state: "connected" },
    client("client:lost", "app", "lost"),
    { client_id: APP, info: { kind: "app" } },
  ) });
  expect(await pickClient(null, SERVER, exec)).toBe(APP);
});

test("pickClient: the caller's block is not looked up on another server", async () => {
  const exec = fakeRex({ "client ls --json": clientsOut(client(APP)) });
  expect(await pickClient({ block: "block:me", server: "unix:///other" }, SERVER, exec)).toBe(APP);
  expect(exec.calls.map((c) => c.join(" ")).some((c) => c.includes("block:me"))).toBe(false);
});

test("rexFocus runs focus_block then session.select with the owner of REX_BLOCK", async () => {
  const exec = fakeRex({
    [focusKey()]: { stdout: "{}" },
    "client ls --json": clientsOut(client("client:other"), client(APP)),
    ...ownerOf("block:me", APP),
    [selectKey(APP)]: {},
  });
  expect(await rexFocus(coords, { block: "block:me", server: SERVER }, exec)).toBe("selected");
  expect(exec.calls.at(-1)).toEqual([
    "--autostart=false", "-S", SERVER, "--timeout", "10s", "-C", APP, "do", "session.select", "-s", S, `session_id=${S}`, `window_id=${W}`,
  ]);
  expect(exec.calls[0]).toContain("session.focus_block");
  expect(verbs(exec.calls)).toEqual(["api", "client", "block", "do"]);
});

test("rexFocus in a popup takes the owner of the tiled block it is given, not the float", async () => {
  const exec = fakeRex({
    [focusKey()]: { stdout: "{}" },
    "client ls --json": clientsOut(client("client:other"), client(APP)),
    ...ownerOf("block:tiled", APP),
    [selectKey(APP)]: {},
  });
  expect(await rexFocus(coords, { block: "block:tiled", server: SERVER }, exec)).toBe("selected");
  expect(exec.calls.map((c) => c.join(" ")).some((c) => c.includes("block:float"))).toBe(false);
});

test("rexFocus for a row on another server uses the sole app there, and only that server", async () => {
  const exec = fakeRex({
    [focusKey()]: { stdout: "{}" },
    "client ls --json": clientsOut(client(APP), client("client:cli", "cli")),
    [selectKey(APP)]: {},
  });
  expect(await rexFocus(coords, { block: "block:me", server: "unix:///caller" }, exec)).toBe("selected");
  for (const c of exec.calls) expect(c.slice(0, 3)).toEqual(["--autostart=false", "-S", SERVER]);
});

test("rexFocus with a null window selects the session alone", async () => {
  const exec = fakeRex({
    [focusKey()]: { stdout: "{}" },
    "client ls --json": clientsOut(client(APP)),
    [`-C ${APP} do session.select -s ${S} session_id=${S}`]: {},
  });
  expect(await rexFocus({ ...coords, window: null }, null, exec)).toBe("selected");
});

test("rexFocus with two apps and no owner focuses only and returns focused-only", async () => {
  const exec = fakeRex({ [focusKey()]: { stdout: "{}" }, "client ls --json": clientsOut(client("client:a"), client("client:b")) });
  expect(await rexFocus(coords, null, exec)).toBe("focused-only");
  expect(exec.calls[0]).toContain("session.focus_block");
  expect(exec.calls.flat()).not.toContain("session.select");
});

test("rexFocus with no app returns no-app and does not throw", async () => {
  const exec = fakeRex({ [focusKey()]: { stdout: "{}" }, "client ls --json": clientsOut(client("client:cli", "cli")) });
  expect(await rexFocus(coords, null, exec)).toBe("no-app");
  expect(exec.calls.flat()).not.toContain("session.select");
});

test("rexFocus reports a failed focus, a failed client listing and a failed select", async () => {
  await expect(rexFocus(coords, null, fakeRex({}))).rejects.toThrow("rex focus failed (exit 4)");
  await expect(rexFocus(coords, null, fakeRex({ [focusKey()]: { stdout: "{}" } }))).rejects.toThrow("rex client ls failed");
  await expect(rexFocus(coords, null, fakeRex({
    [focusKey()]: { stdout: "{}" }, "client ls --json": clientsOut(client(APP)),
  }))).rejects.toThrow("Rex could not switch sessions: session.select exit 4");
});

// Rex.app refuses client actions unless Remote Control is on (seen live).
test("a refused session.select names Rex's reason", async () => {
  const why = "Rex.app is not accepting actions. Turn on Remote Control in its Settings under Rex Server.";
  await expect(rexFocus(coords, null, fakeRex({
    [focusKey()]: { stdout: "{}" }, "client ls --json": clientsOut(client(APP)),
    [selectKey(APP)]: { code: 1, stderr: `Error: ${why}\n` },
  }))).rejects.toThrow(`Rex could not switch sessions: ${why}`);
});

// focus_block alone switches tabs within a session: the app already shows the
// caller's session, so no client action (which Remote Control may refuse).
test("rexFocus in the caller's own session stops after focus_block", async () => {
  const exec = fakeRex({ [focusKey()]: { stdout: "{}" } });
  expect(await rexFocus(coords, { block: "block:tiled", server: SERVER, session: S }, exec)).toBe("selected");
  expect(verbs(exec.calls)).toEqual(["api"]);
});

test("a caller in the same-named session on another server still selects", async () => {
  const exec = fakeRex({
    [focusKey()]: { stdout: "{}" }, "client ls --json": clientsOut(client(APP)), [selectKey(APP)]: {},
  });
  expect(await rexFocus(coords, { block: "block:me", server: "unix:///caller", session: S }, exec)).toBe("selected");
  expect(exec.calls.flat()).toContain("session.select");
});

const opts = (over: Partial<Parameters<typeof openRexRow>[1]> = {}) =>
  ({ caller: "rex" as const, popup: false, currentPane: async () => ({ session: S, window: W, pane: "block:me", socket: SERVER }), ...over });
const selected = () => fakeRex({
  [focusKey()]: { stdout: "{}" }, "client ls --json": clientsOut(client(APP)), ...ownerOf("block:me", APP), [selectKey(APP)]: {},
});

test("openRexRow: an inline dash in Rex stays, a popup closes with an empty handoff", async () => {
  expect(await openRexRow(rexRow(), opts(), selected())).toBeNull();
  const exec = selected();
  expect(await openRexRow(rexRow(), opts({ popup: true }), exec)).toEqual({ argv: [] });
  expect(exec.calls[0]).toContain("session.focus_block"); // ran before the float closes
});

test("openRexRow: outside Rex the caller's pane is not read, and success says so", async () => {
  const currentPane = async () => { throw new Error("no caller pane outside Rex"); };
  expect(await openRexRow(rexRow(), opts({ caller: null, currentPane }), selected())).toEqual({ argv: [], notice: "opened in Rex" });
  expect(await openRexRow(rexRow(), opts({ caller: "tmux", currentPane }), selected())).toEqual({ argv: [], notice: "opened in Rex" });
});

test("openRexRow: several apps give the notice, no app throws", async () => {
  const two = fakeRex({ [focusKey()]: { stdout: "{}" }, "client ls --json": clientsOut(client("client:a"), client("client:b")) });
  expect(await openRexRow(rexRow(), opts({ caller: null }), two)).toEqual({
    argv: [], notice: "opened in Rex; several Rex apps connected, could not switch",
  });
  const none = fakeRex({ [focusKey()]: { stdout: "{}" }, "client ls --json": clientsOut() });
  await expect(openRexRow(rexRow(), opts({ caller: null }), none)).rejects.toThrow("Rex app not running");
});

test("rexUnreachableMessage names the short id", () => {
  expect(rexUnreachableMessage(rexRow().session_id)).toBe("Rex server unreachable; not resuming 019f1898");
});

const TSOCK = "/tmp/tmux-sock";
const tmuxRow = (over: Partial<SessionRow> = {}) =>
  rexRow({ mux: "tmux", tmux_session: "my work:1 #x", tmux_window: "@3", tmux_pane: "%7", tmux_socket: TSOCK, ...over });
const attachArgv = (row: SessionRow) => ["tmux", ...buildAttachCommands(
  { tmux_session: row.tmux_session!, tmux_window: row.tmux_window!, tmux_pane: row.tmux_pane, tmux_socket: row.tmux_socket }, false)[0]!];
const runKey = (row: SessionRow) =>
  ["run", "-s", S, "--label", tmuxTabLabel(row.tmux_socket, row.tmux_session!), "--json", "--", ...holdOnFailure(attachArgv(row))].join(" ");
const newTabOut = { stdout: JSON.stringify({ window_id: "window:t", block_ids: ["block:t"] }) };
const lsOut = (label: string) => ({ stdout: JSON.stringify({ blocks: [{ block_id: "block:t", label }] }) });
const lsKey = `block ls -s ${S} --json`;

test("tmuxTabLabel is stable and has a fixed shape for odd names", () => {
  const l = tmuxTabLabel(null, "my work:1 #x");
  expect(l).toMatch(/^agmux:tmux:[0-9a-z]{1,8}$/);
  expect(tmuxTabLabel(null, "my work:1 #x")).toBe(l);
});

test("two sessions on different sockets get different labels", () => {
  expect(tmuxTabLabel("/a", "work")).not.toBe(tmuxTabLabel("/b", "work"));
  expect(tmuxTabLabel(null, "a")).not.toBe(tmuxTabLabel(null, "b"));
});

test("first open creates a tab running holdOnFailure(tmux attach-session ...)", async () => {
  const row = tmuxRow();
  const exec = fakeRex({ [lsKey]: { stdout: JSON.stringify({ blocks: [] }) }, [runKey(row)]: newTabOut });
  expect(await openTmuxTab(row, opts(), exec)).toBeNull();
  const run = exec.calls.find((c) => c.includes("run"))!;
  expect(run.slice(run.indexOf("--") + 1)).toEqual(holdOnFailure(attachArgv(row)));
  expect(run).toContain(tmuxTabLabel(TSOCK, row.tmux_session!));
  expect(run).not.toContain("--shell=none");
  expect(run.slice(0, run.indexOf("run"))).toEqual(["--autostart=false", "-S", SERVER, "--timeout", "10s"]); // caller's server
  // Deduplicated per current session: other Rex sessions aren't searched.
  expect(exec.calls.some((c) => / ls --json$/.test(c.join(" ")))).toBe(false);
});

test("session names with spaces, ':' and '#' stay single argv elements", async () => {
  const row = tmuxRow();
  const exec = fakeRex({ [lsKey]: { stdout: JSON.stringify({ blocks: [] }) }, [runKey(row)]: newTabOut });
  await openTmuxTab(row, opts(), exec);
  const run = exec.calls.find((c) => c.includes("run"))!;
  expect(run).toContain("my work:1 #x");
  expect(run).toContain("my work:1 #x:@3");
});

test("';' separators are their own argv elements", async () => {
  const row = tmuxRow();
  const exec = fakeRex({ [lsKey]: { stdout: JSON.stringify({ blocks: [] }) }, [runKey(row)]: newTabOut });
  await openTmuxTab(row, opts(), exec);
  const run = exec.calls.find((c) => c.includes("run"))!;
  const tmux = run.slice(run.indexOf("agmux-hold") + 1); // the hold script itself contains ';'
  expect(tmux.filter((a) => a === ";")).toHaveLength(2);
  expect(tmux.some((a) => a !== ";" && a.includes(";"))).toBe(false);
});

test("second open focuses the existing block and selects window and pane over -S", async () => {
  const row = tmuxRow();
  const tmuxCalls: string[][] = [];
  const exec = fakeRex({
    [lsKey]: lsOut(tmuxTabLabel(TSOCK, row.tmux_session!)),
    [focusKey(S, "block:t")]: { stdout: "{}" }, "client ls --json": clientsOut(client(APP)), ...ownerOf("block:me", APP),
    [`-C ${APP} do session.select -s ${S} session_id=${S}`]: {},
  });
  const h = await openTmuxTab(row, opts(), exec, async (a) => { tmuxCalls.push(a); });
  expect(h).toBeNull();
  expect(exec.calls.some((c) => c.includes("run"))).toBe(false);
  expect(tmuxCalls).toEqual([
    ["-S", TSOCK, "select-window", "-t", "my work:1 #x:@3"],
    ["-S", TSOCK, "select-pane", "-t", "%7"],
  ]);
});

test("two rows in one tmux session reuse one tab", async () => {
  const a = tmuxRow(), b = tmuxRow({ tmux_window: "@4", tmux_pane: "%9" });
  expect(tmuxTabLabel(a.tmux_socket, a.tmux_session!)).toBe(tmuxTabLabel(b.tmux_socket, b.tmux_session!));
  const exec = fakeRex({
    [lsKey]: lsOut(tmuxTabLabel(TSOCK, a.tmux_session!)),
    [focusKey(S, "block:t")]: { stdout: "{}" }, "client ls --json": clientsOut(client(APP)), ...ownerOf("block:me", APP),
    [`-C ${APP} do session.select -s ${S} session_id=${S}`]: {},
  });
  await openTmuxTab(a, opts(), exec, async () => {});
  await openTmuxTab(b, opts(), exec, async () => {});
  expect(exec.calls.some((c) => c.includes("run"))).toBe(false);
});

test("a stale label whose block has gone opens a new tab", async () => {
  const row = tmuxRow();
  const exec = fakeRex({ [lsKey]: { stdout: JSON.stringify({ blocks: [{ block_id: "block:x", label: "other" }] }) }, [runKey(row)]: newTabOut });
  await openTmuxTab(row, opts(), exec, async () => { throw new Error("no tmux select"); });
  expect(exec.calls.some((c) => c.includes("run"))).toBe(true);
});

test("in a popup returns empty argv; in an inline dash returns null", async () => {
  const row = tmuxRow();
  const mk = () => fakeRex({ [lsKey]: { stdout: JSON.stringify({ blocks: [] }) }, [runKey(row)]: newTabOut });
  expect(await openTmuxTab(row, opts({ popup: true }), mk())).toEqual({ argv: [] });
  expect(await openTmuxTab(row, opts({ popup: false }), mk())).toBeNull();
});

test("resumeTarget: the caller's session wins", () => {
  const here = { session: "caller", window: "@1", pane: "%1", socket: null };
  expect(resumeTarget(rexRow(), "tmux", here, {})).toBe("caller");
});

test("resumeTarget: without a caller pane a tmux row keeps its name, a Rex row's UUID is never used", () => {
  expect(resumeTarget(rexRow({ mux: null, tmux_session: "work" }), "tmux", null, {})).toBe("work");
  expect(resumeTarget(rexRow({ mux: null, tmux_session: null }), "tmux", null, {})).toBe("agmux");
  expect(resumeTarget(rexRow(), "tmux", null, {})).toBe("agmux");
  expect(resumeTarget(rexRow(), null, null, {})).toBe("agmux");
});

test("resumeTarget: inside Rex without a caller pane stays in the current Rex session", () => {
  expect(resumeTarget(rexRow({ mux: null, tmux_session: "work" }), "rex", null, { REX_SESSION: "session:here" })).toBe("session:here");
});
