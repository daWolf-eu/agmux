import { test, expect } from "bun:test";
import { statuslineCmd, cycleShowCmd, type StatuslineCmdDeps } from "../src/statusline-cmd.ts";
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
  expect(printed).toContain("⠋");
  expect(printed).toContain("range=user|@agx-1");
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

// In-memory cache dir: the show override and the rendered line.
function memFiles(init: Record<string, string> = {}) {
  const files: Record<string, string> = { ...init };
  return {
    files,
    readFile: (p: string) => files[p] ?? null,
    fs: { mkdir: () => {}, write: (f: string, t: string) => { files[f] = t; }, rename: (a: string, b: string) => { files[b] = files[a]!; delete files[a]; } },
  };
}
const CACHE = "/run/u/agmux/statusline";

test("the saved filter mode overrides [statusline] show", async () => {
  const mem = memFiles({ [`${CACHE}.show`]: "waiting\n" });
  let printed = "";
  await statuslineCmd({ hubUrl: "http://h" }, deps({ env: { XDG_RUNTIME_DIR: "/run/u" }, readFile: mem.readFile, out: (s) => { printed = s; } }));
  expect(printed).not.toContain("range=user|@agx-1"); // the running session is filtered out
  expect(printed).toContain("▽");
});

test("an unknown saved mode falls back to the config", async () => {
  const mem = memFiles({ [`${CACHE}.show`]: "bogus" });
  let printed = "";
  await statuslineCmd({ hubUrl: "http://h" }, deps({ env: { XDG_RUNTIME_DIR: "/run/u" }, readFile: mem.readFile, out: (s) => { printed = s; } }));
  expect(printed).toContain("range=user|@agx-1");
});

test("cycleShowCmd saves the next mode and repaints the cache with it", async () => {
  const mem = memFiles();
  const d = deps({ env: { XDG_RUNTIME_DIR: "/run/u" }, readFile: mem.readFile, fs: mem.fs });
  expect(await cycleShowCmd(1, { hubUrl: "http://h" }, d)).toBe(0); // working → all
  expect(mem.files[`${CACHE}.show`]).toBe("all");
  expect(mem.files[CACHE]).toContain("range=user|@agx-1");
  await cycleShowCmd(1, { hubUrl: "http://h" }, d); // all → attention: the running session goes
  expect(mem.files[`${CACHE}.show`]).toBe("attention");
  expect(mem.files[CACHE]).not.toContain("range=user|@agx-1");
  await cycleShowCmd(-1, { hubUrl: "http://h" }, d);
  expect(mem.files[`${CACHE}.show`]).toBe("all");
});

test("cycleShowCmd still saves the mode when the hub is down", async () => {
  const mem = memFiles();
  const d = deps({
    env: { XDG_RUNTIME_DIR: "/run/u" }, readFile: mem.readFile, fs: mem.fs,
    fetchImpl: (async () => { throw new Error("refused"); }) as unknown as typeof fetch,
  });
  expect(await cycleShowCmd(1, { hubUrl: "http://h" }, d)).toBe(0);
  expect(mem.files[`${CACHE}.show`]).toBe("all");
  expect(mem.files[CACHE]).toBeUndefined();
});
