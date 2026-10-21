// `agmux attach` argument and config handling through the real entry point,
// against an in-test hub (HOME points at a temp dir with its port/pid files).
import { afterAll, beforeAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const BIN = process.env.AGMUX_TEST_BIN ?? path.join(import.meta.dir, "..", "bin", "agmux.ts");
const ID = "019f1898-8e0f-7000-ab55-07d09f673b59";
const ROW = {
  session_id: ID, agent_kind: "claude", profile: null, native_session_id: null,
  command: "claude", args: [], env_overrides: {}, cwd: "/tmp", pid: null,
  tmux_session: null, tmux_window: null, tmux_pane: null, tmux_socket: null,
  host: "h", project: null, parent_session_id: null,
  start_ts: "2026-10-21T10:00:00.000Z", last_heartbeat_ts: null,
  end_ts: "2026-10-21T11:00:00.000Z", exit_code: 0, signal: null, status: "exited", origin: "wrapper",
};

let home: string;
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === "/health") return Response.json({ ok: true });
      if (req.method === "POST") return new Response(null, { status: 202 });
      if (u.pathname === "/sessions") return Response.json({ sessions: [ROW] });
      return Response.json({ session: ROW, usage: null });
    },
  });
  home = fs.mkdtempSync(path.join(os.tmpdir(), "agmux-attach-bin-"));
  fs.mkdirSync(path.join(home, ".agmux"));
  fs.writeFileSync(path.join(home, ".agmux", "hub.port"), String(server.port));
  fs.writeFileSync(path.join(home, ".agmux", "hub.pid"), String(process.pid));
  fs.mkdirSync(path.join(home, ".config", "agmux"), { recursive: true });
  fs.writeFileSync(path.join(home, ".config", "agmux", "config.toml"), "[profiles.x\nbroken = ");
});

afterAll(() => {
  server.stop(true);
  fs.rmSync(home, { recursive: true, force: true });
});

async function agmux(...args: string[]): Promise<{ code: number; err: string }> {
  const { TMUX: _t, TMUX_PANE: _p, AGMUX_HUB_URL: _h, ...env } = process.env;
  const p = Bun.spawn(["bun", BIN, ...args], {
    env: { ...env, HOME: home, AGMUX_WRAP_BIN: "/usr/bin/true" }, stdout: "ignore", stderr: "pipe", stdin: "ignore",
  });
  const err = await new Response(p.stderr).text();
  return { code: await p.exited, err };
}

test("a broken config does not fail a plain attach of a local session", async () => {
  const r = await agmux("attach", "019f");
  expect(r.err).toBe("");
  expect(r.code).toBe(0); // resumed via AGMUX_WRAP_BIN=/usr/bin/true
});

test("--placement still reports a broken config", async () => {
  const r = await agmux("attach", "019f", "--placement", "inline");
  expect(r.code).toBe(2);
  expect(r.err).toContain("Invalid TOML");
});

test("--mode without a value is a usage error", async () => {
  const r = await agmux("attach", "019f", "--mode");
  expect(r.code).toBe(2);
  expect(r.err).toContain("attach: --mode must be view|full");
});

test("--remote-client without --mode is a usage error", async () => {
  const r = await agmux("attach", ID, "--remote-client", "--detach-key", "M-d");
  expect(r.code).toBe(2);
  expect(r.err).toContain("attach: --mode must be view|full");
});
