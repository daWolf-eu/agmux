import { test, expect } from "bun:test";
import { statuslineCmd, cachePath, type StatuslineCmdDeps } from "../src/statusline-cmd.ts";
import { loadAttentionConfig } from "../src/attention-config.ts";

function deps(over: Partial<StatuslineCmdDeps> = {}): StatuslineCmdDeps {
  return {
    fetchImpl: (async () => new Response(JSON.stringify({
      sessions: [{
        session_id: "agx-1", agent_kind: "claude", profile: null, native_session_id: null,
        command: "claude", args: [], env_overrides: {}, cwd: "/tmp", pid: 1,
        tmux_session: "work", tmux_window: "2", tmux_socket: null, tmux_pane: null,
        host: "h", project: null, parent_session_id: null, start_ts: "2026-09-11T10:00:00.000Z",
        last_heartbeat_ts: null, end_ts: null, exit_code: null, signal: null,
        status: "running", origin: "native",
      }],
    }), { status: 200 })) as unknown as typeof fetch,
    out: () => {},
    config: loadAttentionConfig(""),
    ...over,
  };
}

test("prints the rendered line to stdout", async () => {
  let printed = "";
  const code = await statuslineCmd({ hubUrl: "http://127.0.0.1:1" }, deps({ out: (s) => { printed = s; } }));
  expect(code).toBe(0);
  expect(printed).toContain("● work:2");
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

test("cachePath honours XDG_RUNTIME_DIR, else falls back to ~/.cache", () => {
  expect(cachePath({ XDG_RUNTIME_DIR: "/run/u", HOME: "/h" })).toBe("/run/u/agmux/statusline");
  expect(cachePath({ HOME: "/h" })).toBe("/h/.cache/agmux/statusline");
});
