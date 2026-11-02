// Runs in its own process so a deadlock can be killed instead of hanging the suite.
//   child <file>: a raw-mode TUI that records its input and redraws all of it on every read.
//   parent <file>: pumps input through ptyWriter into that child, as the wrapper does.
import * as fs from "node:fs";
import { openPty, ptyWriter } from "../../src/pty.ts";

const [role, file] = process.argv.slice(2) as [string, string];

if (role === "child") {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  let seen = 0;
  process.stdin.on("data", (b: Buffer) => {
    fs.appendFileSync(file, b);
    seen += b.length;
    fs.writeSync(1, `\r${"L".repeat(seen)}`);
  });
} else {
  const { master, slave, slaveOut, slaveErr } = openPty(24, 80);
  const child = Bun.spawn(["bun", import.meta.path, "child", file], { stdin: slave, stdout: slaveOut, stderr: slaveErr });
  for (const fd of [slave, slaveOut, slaveErr]) fs.closeSync(fd);
  const out = fs.createReadStream("", { fd: master, autoClose: false });
  out.on("data", () => {});
  out.on("error", () => {});
  await Bun.sleep(500); // the child's raw mode
  const write = ptyWriter(master);
  const total = Number(process.env.PUMP_BYTES);
  const input = Buffer.from(Array.from({ length: total }, (_, i) => 97 + (i % 26)));
  for (let off = 0; off < total; off += 1024) write(input.subarray(off, off + 1024));
  while ((fs.existsSync(file) ? fs.statSync(file).size : 0) < total) await Bun.sleep(20);
  child.kill();
  process.exit(0);
}
