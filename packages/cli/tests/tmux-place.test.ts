import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolvePaneCoords, holdOnFailure, newWindow } from "../src/tmux-place.ts";

test("parses session_name<TAB>window_id from tmux", async () => {
  const fakeExec = async (_args: string[]) => "agmux\t@4\n";
  expect(await resolvePaneCoords("%7", fakeExec)).toEqual({ session: "agmux", window: "@4" });
});

test("returns null on exec failure", async () => {
  const fakeExec = async () => { throw new Error("no tmux"); };
  expect(await resolvePaneCoords("%7", fakeExec)).toBeNull();
});

test("returns null on malformed output", async () => {
  const fakeExec = async () => "garbage\n";
  expect(await resolvePaneCoords("%7", fakeExec)).toBeNull();
});

test("prepends -S <socket> to the exec args when a socket is given", async () => {
  let seen: string[] = [];
  const fakeExec = async (args: string[]) => { seen = args; return "agmux\t@4\n"; };
  await resolvePaneCoords("%7", fakeExec, "/tmp/sock");
  expect(seen.slice(0, 2)).toEqual(["-S", "/tmp/sock"]);
  expect(seen).toContain("display-message");
});

test("omits -S when socket is null", async () => {
  let seen: string[] = [];
  const fakeExec = async (args: string[]) => { seen = args; return "agmux\t@4\n"; };
  await resolvePaneCoords("%7", fakeExec, null);
  expect(seen[0]).toBe("display-message");
});

// ---- holdOnFailure: a placed command that fails keeps its pane until a key ----

async function runHeld(cmd: string[], stdin?: string) {
  const p = Bun.spawn(holdOnFailure(cmd), { stdin: stdin === undefined ? "ignore" : new Blob([stdin]), stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  await p.exited;
  return { out, code: p.exitCode };
}

test("holdOnFailure passes a successful command straight through", async () => {
  expect(await runHeld(["sh", "-c", "echo hi"])).toEqual({ out: "hi\n", code: 0 });
});

test("holdOnFailure reports a failure, waits for one key, then exits with its status", async () => {
  const r = await runHeld(["sh", "-c", "exit 3"], "x");
  expect(r.code).toBe(3);
  expect(r.out).toContain("[agmux] sh exited with status 3. Press any key to close.");
});

test("holdOnFailure keeps a missing command's own error visible", async () => {
  const p = Bun.spawn(holdOnFailure(["agmux-no-such-binary"]), { stdin: new Blob(["x"]), stdout: "pipe", stderr: "pipe" });
  const err = await new Response(p.stderr).text();
  await p.exited;
  expect(p.exitCode).toBe(127);
  expect(err).toContain("agmux-no-such-binary");
});

test("holdOnFailure: no argument ends in ';', which an outer tmux would take as a separator", () => {
  for (const a of holdOnFailure(["x"])) expect(a.endsWith(";")).toBe(false);
});

// Real tmux on an isolated socket: the failed pane stays until a key is pressed.
async function tmuxOn(sock: string, args: string[]): Promise<string> {
  const p = Bun.spawn(["tmux", "-S", sock, "-f", "/dev/null", ...args], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  await p.exited;
  return out.trim();
}

async function waitFor(check: () => Promise<boolean>, ms = 3000): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(50)) if (await check()) return true;
  return false;
}

test("a failed command in a new window keeps the window until a key, a successful one closes it", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agmux-hold-"));
  const sock = path.join(dir, "s");
  try {
    await tmuxOn(sock, ["new-session", "-d", "-s", "base", "sleep 30"]);
    const failed = await newWindow({ sessionName: "base", windowName: "f", cmd: ["sh", "-c", "echo boom >&2; exit 1"], env: {}, detach: true, socket: sock });
    const ok = await newWindow({ sessionName: "base", windowName: "o", cmd: ["true"], env: {}, detach: true, socket: sock });
    const windows = () => tmuxOn(sock, ["list-windows", "-t", "base", "-F", "#{window_id}"]);
    expect(await waitFor(async () => !(await windows()).includes(ok.window))).toBe(true);
    expect(await waitFor(async () => (await tmuxOn(sock, ["capture-pane", "-p", "-t", failed.pane])).includes("Press any key"))).toBe(true);
    const shown = await tmuxOn(sock, ["capture-pane", "-p", "-t", failed.pane]);
    expect(shown).toContain("boom");
    expect(await windows()).toContain(failed.window);
    await tmuxOn(sock, ["send-keys", "-t", failed.pane, "x"]);
    expect(await waitFor(async () => !(await windows()).includes(failed.window))).toBe(true);
  } finally {
    await tmuxOn(sock, ["kill-server"]);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
