// Minimal harness: PTY allocation + child spawn + signal/exit handling.
// Lifecycle/heartbeat/hub bits come in later tasks.
import * as fs from "node:fs";
import { openPty, setWinsize } from "../src/pty.ts";

const sep = process.argv.indexOf("--");
const cmd = sep >= 0 ? process.argv.slice(sep + 1) : process.argv.slice(2);
if (cmd.length === 0) { console.error("usage: --  <command> [args...]"); process.exit(2); }

const initRows = process.stdout.rows || 24;
const initCols = process.stdout.columns || 80;
const { master, slave, slaveOut, slaveErr } = openPty(initRows, initCols);

const child = Bun.spawn(cmd, {
  stdin: slave, stdout: slaveOut, stderr: slaveErr,
  env: { ...process.env, AGMUX_SESSION_ID: process.env.AGMUX_SESSION_ID ?? "test-001" },
});
for (const fd of [slave, slaveOut, slaveErr]) { try { fs.closeSync(fd); } catch {} }

const stdinIsTty = process.stdin.isTTY;
if (stdinIsTty) process.stdin.setRawMode(true);
const restore = () => { if (stdinIsTty) { try { process.stdin.setRawMode(false); } catch {} } };

const mr = fs.createReadStream("", { fd: master, autoClose: false });
mr.on("data", (chunk) => process.stdout.write(chunk));
mr.on("error", () => {});
process.stdin.on("data", (chunk: Buffer) => { try { fs.writeSync(master, chunk); } catch {} });
if (stdinIsTty) process.stdin.resume();

process.stdout.on("resize", () => {
  setWinsize(master, process.stdout.rows || 24, process.stdout.columns || 80);
});
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"] as const) {
  process.on(sig, () => { try { child.kill(sig); } catch {} });
}

await child.exited;
restore();
try { fs.closeSync(master); } catch {}
if (child.signalCode) {
  process.removeAllListeners(child.signalCode);
  process.kill(process.pid, child.signalCode);
} else {
  process.exit(child.exitCode ?? 0);
}
