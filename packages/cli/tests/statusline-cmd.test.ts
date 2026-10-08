import { test, expect } from "bun:test";
import { statuslineCmd, type StatuslineCmdDeps } from "../src/statusline-cmd.ts";
import { loadAttentionConfig } from "../src/attention-config.ts";

function deps(over: Partial<StatuslineCmdDeps> = {}): StatuslineCmdDeps {
  return {
    fetchImpl: (async () => new Response(JSON.stringify({
      sessions: [{
        session_id: "agx-1", agent_kind: "claude", profile: null, native_session_id: null,
        command: "claude", args: [], env_overrides: {}, cwd: "/tmp", pid: 1,
        tmux_session: "work", tmux_window: "@2", tmux_socket: null, tmux_pane: "%7",
        host: "h", project: null, parent_session_id: null, start_ts: "2026-09-11T10:00:00.000Z",
        last_heartbeat_ts: null, end_ts: null, exit_code: null, signal: null,
        status: "running", origin: "native",
      }],
    }), { status: 200 })) as unknown as typeof fetch,
    out: () => {},
    config: loadAttentionConfig(""),
    env: {},
    readFile: () => null,
    ...over,
  };
}

test("prints the rendered line to stdout", async () => {
  let printed = "";
  const code = await statuslineCmd({ hubUrl: "http://127.0.0.1:1" }, deps({ out: (s) => { printed = s; } }));
  expect(code).toBe(0);
  expect(printed).toContain("⠋ work:%7");
});

test("a hub error prints a dim marker and still exits 0", async () => {
  let printed = "";
  const code = await statuslineCmd(
    { hubUrl: "http://127.0.0.1:1" },
    deps({ fetchImpl: (async () => { throw new Error("refused"); }) as unknown as typeof fetch, out: (s) => { printed = s; } }),
  );
  expect(code).toBe(0);
  expect(printed).toContain("hub down");
});

test("exit code stays 0 so tmux never paints an error", async () => {
  const code = await statuslineCmd(
    { hubUrl: "http://127.0.0.1:1" },
    deps({ fetchImpl: (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch }),
  );
  expect(code).toBe(0);
});

test("--check reads the cache file directly, without touching the hub", async () => {
  let printed = "";
  const files: Record<string, string> = {
    "/run/u/agmux/statusline": "cached-line",
    "/run/u/agmux/statusline.heartbeat": new Date().toISOString(),
  };
  const code = await statuslineCmd(
    { hubUrl: "http://127.0.0.1:1", check: true },
    deps({
      env: { XDG_RUNTIME_DIR: "/run/u" },
      readFile: (p) => files[p] ?? null,
      fetchImpl: (async () => { throw new Error("must not be called"); }) as unknown as typeof fetch,
      out: (s) => { printed = s; },
    }),
  );
  expect(code).toBe(0);
  expect(printed).toBe("cached-line");
});

test("--print-config prints the resolved enabled/position as key=value lines", async () => {
  const printed: string[] = [];
  const code = await statuslineCmd(
    { hubUrl: "", printConfig: true },
    deps({
      config: loadAttentionConfig(`[statusline]\nenabled = false\nposition = "status-right"\n`),
      out: (s) => { printed.push(s); },
      fetchImpl: (async () => { throw new Error("must not be called"); }) as unknown as typeof fetch,
    }),
  );
  expect(code).toBe(0);
  expect(printed).toEqual(["enabled=false", "position=status-right"]);
});

test("--print-config prints defaults for an empty config", async () => {
  const printed: string[] = [];
  const code = await statuslineCmd(
    { hubUrl: "", printConfig: true },
    deps({ config: loadAttentionConfig(""), out: (s) => { printed.push(s); } }),
  );
  expect(code).toBe(0);
  expect(printed).toEqual(["enabled=false", "position=status2"]);
});

test("--check prints a stale marker when the heartbeat is missing or old", async () => {
  let printed = "";
  const code = await statuslineCmd(
    { hubUrl: "http://127.0.0.1:1", check: true },
    deps({
      env: { XDG_RUNTIME_DIR: "/run/u" },
      readFile: () => null,
      out: (s) => { printed = s; },
    }),
  );
  expect(code).toBe(0);
  expect(printed).toContain("stale");
});
