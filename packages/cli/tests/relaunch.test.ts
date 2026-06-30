import { test, expect } from "bun:test";
import { buildRelaunchSpec } from "../src/relaunch.ts";
import { createRegistry } from "@agmux/adapters";
import { fakeAdapter } from "@agmux/adapters/testing";
import type { SessionRow } from "@agmux/protocol";

function row(over: Partial<SessionRow>): SessionRow {
  return {
    session_id: "sid", agent_kind: "claude", profile: null, native_session_id: null,
    command: "claude", args: ["--foo"], env_overrides: { A: "1" }, cwd: "/work",
    pid: null, tmux_session: null, tmux_window: null, tmux_pane: null, tmux_socket: null, host: "h",
    project: null, parent_session_id: null, start_ts: "t", last_heartbeat_ts: null,
    end_ts: null, exit_code: null, signal: null, status: "ended", origin: "wrapper", ...over,
  };
}

function emptyReg() { return createRegistry(); }
function fakeReg() { const r = createRegistry(); r.register(fakeAdapter); return r; }

test("no adapter, profile-backed → relaunch by profile name", () => {
  const spec = buildRelaunchSpec(row({ profile: "work" }), {
    hubUrl: "http://hub", wrapBin: "agmux-wrap", registry: emptyReg(), baseEnv: {},
  });
  expect(spec.wrapArgv).toEqual(["agmux-wrap", "work"]);
  expect(spec.env.AGMUX_SESSION_ID).toBe("sid");
  expect(spec.env.AGMUX_HUB_URL).toBe("http://hub");
  expect(spec.env.AGMUX_INLINE_PROFILE).toBeUndefined();
});

test("no adapter, ad-hoc (no profile) → reconstruct inline profile (today's behavior)", () => {
  const spec = buildRelaunchSpec(row({ profile: null }), {
    hubUrl: "http://hub", wrapBin: "agmux-wrap", registry: emptyReg(), baseEnv: {},
  });
  const inline = JSON.parse(spec.env.AGMUX_INLINE_PROFILE!);
  expect(inline.command).toBe("claude");
  expect(inline.args).toEqual(["--foo"]);
});

test("adapter + native_session_id → relaunch with the resume argv", () => {
  const spec = buildRelaunchSpec(
    row({ profile: "work", native_session_id: "native-xyz" }),
    { hubUrl: "http://hub", wrapBin: "agmux-wrap", registry: fakeReg(), baseEnv: {} },
  );
  const inline = JSON.parse(spec.env.AGMUX_INLINE_PROFILE!);
  expect(inline.command).toBe("fake-cli");
  expect(inline.args).toEqual(["resume", "native-xyz"]);
});

test("adapter present but no native_session_id → falls back to normal relaunch", () => {
  const spec = buildRelaunchSpec(row({ profile: "work", native_session_id: null }), {
    hubUrl: "http://hub", wrapBin: "agmux-wrap", registry: fakeReg(), baseEnv: {},
  });
  expect(spec.wrapArgv).toEqual(["agmux-wrap", "work"]); // resumePlan returned resumable:false
});

test("adapter + native id but zero observed turns → fresh relaunch (empty conversations don't persist)", () => {
  const spec = buildRelaunchSpec(
    row({ profile: "work", native_session_id: "native-xyz" }),
    { hubUrl: "http://hub", wrapBin: "agmux-wrap", registry: fakeReg(), baseEnv: {}, turnCount: 0 },
  );
  expect(spec.wrapArgv).toEqual(["agmux-wrap", "work"]); // no --resume attempted
});

test("adapter + native id + observed turns → native resume", () => {
  const spec = buildRelaunchSpec(
    row({ profile: "work", native_session_id: "native-xyz" }),
    { hubUrl: "http://hub", wrapBin: "agmux-wrap", registry: fakeReg(), baseEnv: {}, turnCount: 3 },
  );
  const inline = JSON.parse(spec.env.AGMUX_INLINE_PROFILE!);
  expect(inline.args).toEqual(["resume", "native-xyz"]);
});

test("turnCount omitted (no usage data) keeps today's resume behavior", () => {
  const spec = buildRelaunchSpec(
    row({ profile: "work", native_session_id: "native-xyz" }),
    { hubUrl: "http://hub", wrapBin: "agmux-wrap", registry: fakeReg(), baseEnv: {} },
  );
  const inline = JSON.parse(spec.env.AGMUX_INLINE_PROFILE!);
  expect(inline.args).toEqual(["resume", "native-xyz"]);
});

test("native resume merges profile env over captured env (profile wins)", () => {
  const spec = buildRelaunchSpec(
    row({ profile: "work", native_session_id: "n", env_overrides: { CLAUDE_CONFIG_DIR: "/captured", X: "1" } }),
    {
      hubUrl: "http://hub", wrapBin: "agmux-wrap", registry: fakeReg(), baseEnv: {}, turnCount: 3,
      loadProfileEnv: (name) => (name === "work" ? { CLAUDE_CONFIG_DIR: "/profile" } : undefined),
    },
  );
  const inline = JSON.parse(spec.env.AGMUX_INLINE_PROFILE!);
  expect(inline.args).toEqual(["resume", "n"]);     // still a native resume
  expect(inline.env.CLAUDE_CONFIG_DIR).toBe("/profile"); // profile wins over captured
  expect(inline.env.X).toBe("1");                   // captured-only key preserved
});

test("native resume carries captured env when there is no profile loader", () => {
  const spec = buildRelaunchSpec(
    row({ profile: null, native_session_id: "n", env_overrides: { CLAUDE_CONFIG_DIR: "/captured" } }),
    { hubUrl: "http://hub", wrapBin: "agmux-wrap", registry: fakeReg(), baseEnv: {}, turnCount: 3 },
  );
  const inline = JSON.parse(spec.env.AGMUX_INLINE_PROFILE!);
  expect(inline.env.CLAUDE_CONFIG_DIR).toBe("/captured");
});
