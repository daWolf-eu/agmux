import { test, expect, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// An explicit socket: it beats an inherited $TMUX, so a run inside tmux can never
// reach (or kill-server) the caller's server.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agmux-coords-"));
const tmux = (...args: string[]) => Bun.spawnSync(["tmux", "-S", path.join(dir, "s"), "-f", "/dev/null", ...args], { stdout: "pipe", stderr: "pipe" });

afterAll(() => {
  tmux("kill-server");
  fs.rmSync(dir, { recursive: true, force: true });
});

// Without a target, display-message answers with the active pane, which isn't
// ours when the agent starts in the background (`agmux run -d`).
test("a wrapper in a background window records its own pane", async () => {
  const out = path.join(dir, "coords.json");
  const fixture = path.join(import.meta.dir, "fixtures/print-tmux-coords.ts");
  expect(tmux("new-session", "-d", "-s", "t", "sleep 30").exitCode).toBe(0);
  expect(tmux("new-window", "-d", "-t", "t:", `${process.execPath} ${fixture} ${out}; sleep 30`).exitCode).toBe(0);
  for (let i = 0; i < 100 && !fs.existsSync(out); i++) await Bun.sleep(50);
  const { coords, own } = JSON.parse(fs.readFileSync(out, "utf8"));
  expect(own).toMatch(/^%\d+$/);
  expect(coords.pane).toBe(own);
}, 10000);
