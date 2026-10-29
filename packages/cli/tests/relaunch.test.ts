import { test, expect } from "bun:test";
import { buildRelaunchSpec, buildDirectRelaunch } from "../src/relaunch.ts";
import { createRegistry, createDefaultRegistry } from "@agmux/adapters";
import { fakeAdapter } from "@agmux/adapters/testing";
import { parseLaunchSpec, type LaunchSpec, type SessionRow } from "@agmux/protocol";

function row(over: Partial<SessionRow>): SessionRow {
  return {
    tmux_server: null,
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

// --- Launch used on resume (spec §5.2.1) ---

const profiles: Record<string, { command: string; args: string[]; env: Record<string, string> }> = {
  p: { command: "claude", args: ["--model", "x"], env: { P: "1" } },
  fb: { command: "/opt/claude", args: ["--fb"], env: { F: "1" } },
};
const loadProfileLaunch = (name: string) => profiles[name];
const base = { hubUrl: "http://hub", registry: createDefaultRegistry(), baseEnv: {}, turnCount: 3, loadProfileLaunch };
const N = "native-1";
// A hook-only row: no recorded launch (command === agent_kind, no args, no profile).
const nativeRow = () => row({ profile: null, native_session_id: N, command: "claude", args: [], env_overrides: {} });
const skipPerms: LaunchSpec = { profile: null, command: "claude", args: ["--dangerously-skip-permissions"] };

function inlineArgv(spec: { env: Record<string, string> }): string[] {
  const inline = JSON.parse(spec.env.AGMUX_INLINE_PROFILE!);
  return [inline.command, ...inline.args];
}

test("profile row: resume passes the profile's args (both builders)", () => {
  const r = row({ profile: "p", native_session_id: N, command: "claude", args: [] });
  expect(inlineArgv(buildRelaunchSpec(r, { ...base, wrapBin: "agmux-wrap" })))
    .toEqual(["claude", "--resume", N, "--model", "x"]);
  const d = buildDirectRelaunch(r, { ...base, agmuxBin: "agmux" });
  expect(d.argv).toEqual(["claude", "--resume", N, "--model", "x"]);
  expect(d.launch).toEqual({ profile: "p", command: "claude", args: ["--model", "x"] });
  expect(d.env.P).toBe("1"); // profile env applied without a separate loadProfileEnv
});

test("profile row whose profile no longer loads → row's command/args, never fails", () => {
  const r = row({ profile: "gone", native_session_id: N, command: "claude", args: ["--a"] });
  const d = buildDirectRelaunch(r, { ...base, agmuxBin: "agmux" });
  expect(d.argv).toEqual(["claude", "--resume", N, "--a"]);
  expect(d.launch).toEqual({ profile: null, command: "claude", args: ["--a"] });
});

test("native row without recorded launch uses the fallback launch", () => {
  const spec = buildRelaunchSpec(nativeRow(), { ...base, wrapBin: "agmux-wrap", fallbackLaunch: skipPerms });
  expect(inlineArgv(spec)).toEqual(["claude", "--resume", N, "--dangerously-skip-permissions"]);
  const d = buildDirectRelaunch(nativeRow(), { ...base, agmuxBin: "agmux", fallbackLaunch: skipPerms });
  expect(d.argv).toEqual(["claude", "--resume", N, "--dangerously-skip-permissions"]);
  expect(d.launch).toEqual(skipPerms);
});

test("fallback launch naming a profile resolves through loadProfileLaunch", () => {
  const d = buildDirectRelaunch(nativeRow(), {
    ...base, agmuxBin: "agmux", fallbackLaunch: { profile: "fb", command: "ignored", args: [] },
  });
  expect(d.argv).toEqual(["/opt/claude", "--resume", N, "--fb"]);
  expect(d.launch).toEqual({ profile: "fb", command: "/opt/claude", args: ["--fb"] });
  expect(d.env.F).toBe("1");
});

test("recorded args win over the fallback launch", () => {
  const r = row({ profile: null, native_session_id: N, command: "claude", args: ["--a"] });
  const fallbackLaunch: LaunchSpec = { profile: null, command: "claude", args: ["--b"] };
  expect(inlineArgv(buildRelaunchSpec(r, { ...base, wrapBin: "agmux-wrap", fallbackLaunch })))
    .toEqual(["claude", "--resume", N, "--a"]);
  expect(buildDirectRelaunch(r, { ...base, agmuxBin: "agmux", fallbackLaunch }).argv)
    .toEqual(["claude", "--resume", N, "--a"]);
});

test("direct relaunch env: AGMUX_LAUNCH is the used launch, no AGMUX_SESSION_ID", () => {
  const d = buildDirectRelaunch(nativeRow(), {
    ...base, agmuxBin: "/usr/local/bin/agmux", fallbackLaunch: skipPerms,
    baseEnv: { PATH: "/bin", AGMUX_SESSION_ID: "inherited", UNSET: undefined },
  });
  expect(parseLaunchSpec(d.env.AGMUX_LAUNCH)).toEqual(skipPerms);
  expect(d.env.AGMUX_SESSION_ID).toBeUndefined();
  expect(d.env.AGMUX_HUB_URL).toBe("http://hub");
  expect(d.env.AGMUX_BIN).toBe("/usr/local/bin/agmux");
  expect(d.env.PATH).toBe("/bin");
  expect("UNSET" in d.env).toBe(false);
  expect(d.cwd).toBe("/work");
});

test("direct relaunch, not resumable → launch command + args, no wrapper", () => {
  const d = buildDirectRelaunch(nativeRow(), { ...base, agmuxBin: "agmux", fallbackLaunch: skipPerms, turnCount: 0 });
  expect(d.argv).toEqual(["claude", "--dangerously-skip-permissions"]);
});
