import { test, expect } from "bun:test";
import { rexTarget, resolveRexBin, defaultRexExec, readCurrentRexCoords } from "../src/rex.ts";
import { fakeRex } from "../../cli/tests/helpers/fake-rex.ts";

const MAC = "/h/Library/Application Support/com.superlogical.rex/RexServer/Versions/Current/Rex Server.app/Contents/MacOS/rex";

test("rexTarget pins the server and disables autostart", () => {
  expect(rexTarget("unix:///a%20b/s.sock")).toEqual(["--autostart=false", "-S", "unix:///a%20b/s.sock", "--timeout", "2s"]);
  expect(rexTarget(null, "10s")).toEqual(["--autostart=false", "--timeout", "10s"]);
});
test("resolveRexBin order: PATH, then REX_BIN_DIR, then the macOS app path", () => {
  const env = { PATH: "/x:/y", REX_BIN_DIR: "/r", HOME: "/h" };
  expect(resolveRexBin(env, () => true)).toBe("/x/rex");
  expect(resolveRexBin(env, (p) => p !== "/x/rex" && p !== "/y/rex")).toBe("/r/rex");
  expect(resolveRexBin(env, (p) => p === MAC)).toBe(MAC);
});
test("resolveRexBin returns null when none exist", () => {
  expect(resolveRexBin({ PATH: "/x", HOME: "/h" }, () => false)).toBeNull();
});
test("defaultRexExec with no binary returns code 127 and does not throw", async () => {
  const keys = ["PATH", "HOME", "REX_BIN_DIR"] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  process.env.PATH = "/nonexistent"; delete process.env.REX_BIN_DIR; process.env.HOME = "/nonexistent-home";
  try {
    expect(await defaultRexExec(["ls"])).toEqual({ code: 127, stdout: "" });
  } finally {
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
});
const env = { REX_SESSION: "S1", REX_BLOCK: "B1", REX_SERVER: "unix:///s.sock" };
test("readCurrentRexCoords combines whoami with the session label", async () => {
  const ex = fakeRex({
    "whoami --json": { stdout: JSON.stringify({ session_id: "S1", window_id: "W1", block_id: "B1" }) },
    "ls --json": { stdout: JSON.stringify({ sessions: [{ session_id: "S0", label: "no" }, { session_id: "S1", label: "work" }] }) },
  });
  expect(await readCurrentRexCoords(env, ex)).toEqual({ session: "S1", window: "W1", pane: "B1", socket: "unix:///s.sock", label: "work" });
  expect(ex.calls.every((c) => c[0] === "--autostart=false" && c.includes("-S") && c.includes("--timeout"))).toBe(true);
});
test("readCurrentRexCoords falls back to env ids with window null when whoami fails", async () => {
  expect(await readCurrentRexCoords(env, fakeRex({}))).toEqual({ session: "S1", window: null, pane: "B1", socket: "unix:///s.sock", label: null });
  const other = fakeRex({ "whoami --json": { stdout: JSON.stringify({ session_id: "S9", window_id: "W9", block_id: "B9" }) } });
  expect((await readCurrentRexCoords(env, other))!.window).toBeNull();
});
test("readCurrentRexCoords returns null when REX_BLOCK or REX_SESSION is unset", async () => {
  expect(await readCurrentRexCoords({ REX_SESSION: "S1" }, fakeRex({}))).toBeNull();
  expect(await readCurrentRexCoords({ REX_BLOCK: "B1" }, fakeRex({}))).toBeNull();
});

test("readCurrentCoords in Rex returns mux rex and never calls tmux", async () => {
  const { readCurrentCoords } = await import("../src/index.ts");
  const rex = fakeRex({
    "whoami --json": { stdout: JSON.stringify({ session_id: "S1", window_id: "W1", block_id: "B1" }) },
    "ls --json": { stdout: JSON.stringify({ sessions: [{ session_id: "S1", label: "work" }] }) },
  });
  const c = await readCurrentCoords({ REX_BLOCK: "B1", REX_SESSION: "S1", REX_SERVER: "srv" }, rex);
  expect(c).toEqual({ session: "S1", window: "W1", pane: "B1", socket: "srv", mux: "rex", label: "work" });
});

test("readCurrentCoords in Rex with a failing whoami returns env ids, never null into the tmux path", async () => {
  const { readCurrentCoords } = await import("../src/index.ts");
  const c = await readCurrentCoords({ REX_BLOCK: "B1", REX_SESSION: "S1" }, fakeRex({}));
  expect(c).toMatchObject({ session: "S1", window: null, pane: "B1", mux: "rex" });
  // Only REX_SERVER set: still Rex, still not null.
  const d = await readCurrentCoords({ REX_SERVER: "srv" }, fakeRex({}));
  expect(d).toMatchObject({ mux: "rex", pane: null, socket: "srv" });
});
