import { test, expect, afterEach } from "bun:test";
import { $ } from "bun";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  FAKE_OPENSHELL, makeTestEnv, waitFor, warmHub, cleanupAllTestEnvs, envOf, hubUrl, getJson, postIngest,
  writeSandboxShims, type TestEnv,
} from "./helpers.ts";

// Replication with no OpenShell: two real hubs in temp HOMEs ("mac" and the
// sandboxes box1/box2), a fake `openshell` that maps each sandbox to
// $FAKE_OS_DIR/<name> as its HOME, and the Mac hub's sync loop in between.

// Every hub (Mac and sandboxes) lives in a makeTestEnv() root, so the helpers
// kill it by its pid file; the Mac hub's sync stop terminates the followers.
afterEach(() => cleanupAllTestEnvs());

// A sandbox: its own env, reachable as $FAKE_OS_DIR/<name> (the HOME the fake sets).
function makeSandbox(fakeDir: string, name: string): TestEnv {
  const e = makeTestEnv();
  fs.symlinkSync(e.root, path.join(fakeDir, name));
  return e;
}

interface SessionRow { session_id: string; host: string; native_session_id: string | null }
interface HostRow { host: string; last_sync_ok: boolean; last_error: string | null; removed_ts: string | null }

test("Mac hub replicates a sandbox hub through a fake openshell", async () => {
  const mac = makeTestEnv();
  const fakeDir = path.join(mac.root, "fake-os");
  fs.mkdirSync(fakeDir);
  const box1 = makeSandbox(fakeDir, "box1");
  makeSandbox(fakeDir, "box2");
  const sbxCli = writeSandboxShims(fakeDir);
  fs.writeFileSync(path.join(fakeDir, "list.json"), JSON.stringify({ next_page_token: "", sandboxes: [{ name: "box1" }] }));

  // The sandbox's own (native) session, stamped with the host the Mac will expect.
  // pid: a live process, so no liveness sweep can end the session under the test.
  await warmHub(box1.cliBin, envOf(box1));
  const box1$ = hubUrl(box1);
  const identity = { agent_kind: "claude", native_session_id: `nat-${crypto.randomUUID()}` };
  const ts = new Date().toISOString();
  await postIngest(box1$, {
    event_id: crypto.randomUUID(), ts, identity, kind: "session.registered", version: 1, host: "gw/box1",
    payload: { ...identity, pid: process.pid, cwd: "/tmp", tmux_session: null, tmux_window: null,
      tmux_pane: null, profile: null, agent_version: null, parent: null },
  });
  await postIngest(box1$, {
    event_id: crypto.randomUUID(), ts, identity, kind: "turn.ended", version: 1, host: "gw/box1", payload: {},
  });
  const sid = (await getJson<{ sessions: SessionRow[] }>(`${box1$}/sessions`)).sessions
    .find((s) => s.native_session_id === identity.native_session_id)!.session_id;

  fs.appendFileSync(mac.configPath, `
[[remote]]
name = "t"
gateway = "gw"
interval = 0.2
openshell_bin = ${JSON.stringify(FAKE_OPENSHELL)}
agmux_bin = ${JSON.stringify(sbxCli)}
`);
  const macEnv = envOf(mac, { FAKE_OS_DIR: fakeDir });
  await warmHub(mac.cliBin, macEnv);   // starts the Mac hub, which starts its sync loop
  const mac$ = hubUrl(mac);

  // 1. The sandbox session shows up on the Mac as remote, under its sandbox host.
  const remote = async () =>
    (await getJson<{ sessions: SessionRow[] }>(`${mac$}/sessions?locality=remote`)).sessions;
  await waitFor(async () => (await remote()).some((s) => s.session_id === sid), 10_000);
  expect((await remote()).find((s) => s.session_id === sid)!.host).toBe("gw/box1");
  const local = (await getJson<{ sessions: SessionRow[] }>(`${mac$}/sessions?locality=local`)).sessions;
  expect(local.some((s) => s.session_id === sid)).toBe(false);

  // 2. box1 disappears from the listing → its sessions are lost by rule host-removed.
  fs.writeFileSync(path.join(fakeDir, "list.json"), "[]");
  const rule = async () => {
    const r = await $`${mac.cliBin} explain ${sid} --json`.env(macEnv).nothrow().quiet();
    return r.exitCode === 0 ? (JSON.parse(r.stdout.toString()) as { rule: string }).rule : null;
  };
  await waitFor(async () => (await rule()) === "host-removed", 5_000);

  // 3. A sandbox created without AGMUX_HOST stamps the machine hostname: a permanent sync failure.
  fs.writeFileSync(path.join(fakeDir, "nohost"), "box2\n");
  fs.writeFileSync(path.join(fakeDir, "list.json"), JSON.stringify([{ name: "box2" }]));
  const box2Row = async () =>
    (await getJson<{ hosts: HostRow[] }>(`${mac$}/hosts`)).hosts.find((h) => h.host === "gw/box2");
  await waitFor(async () => (await box2Row()) !== undefined, 10_000);
  const row = (await box2Row())!;
  expect(row.last_sync_ok).toBe(false);
  expect(row.last_error).toContain("AGMUX_HOST");
}, 30_000);
