// Runs in its own process so a deadlock can be killed instead of hanging the suite.
//   child <file>: a raw-mode TUI that records its input and redraws all of it on every read.
//   idle: raw mode, never reads, so the tty queue fills and writes block.
//   parent <file>: pumps input through ptyWriter into `child`, as the wrapper does.
//   stop <file>: stops the writer with a write blocked and chunks queued, closes the fd as
//     the wrapper does, reuses its number for <file>; nothing queued may land there.
//   stuck: the child never drains, so stop must give up rather than hang the wrapper.
import * as fs from "node:fs";
import { openPty, ptyWriter } from "../../src/pty.ts";

const READY = "pty-pump-ready";
const [role, file] = process.argv.slice(2) as [string, string];

function start(childRole: string, childArgs: string[] = []) {
  const { master, slave, slaveOut, slaveErr } = openPty(24, 80);
  const child = Bun.spawn(["bun", import.meta.path, childRole, ...childArgs], { stdin: slave, stdout: slaveOut, stderr: slaveErr });
  for (const fd of [slave, slaveOut, slaveErr]) fs.closeSync(fd);
  const out = fs.createReadStream("", { fd: master, autoClose: false });
  out.on("error", () => {});
  const ready = new Promise<void>((resolve) => {
    let seen = "";
    out.on("data", (b) => { seen = (seen + b.toString()).slice(-READY.length * 2); if (seen.includes(READY)) resolve(); });
  });
  return { master, child, ready };
}

async function fillQueue(master: number) {
  const writer = ptyWriter(master);
  for (let i = 0; i < 64; i++) writer.write(Buffer.alloc(1024, 0x78));
  await Bun.sleep(100); // the first write is in flight and blocked
  return writer;
}

if (role === "child") {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  let seen = 0;
  process.stdin.on("data", (b: Buffer) => {
    fs.appendFileSync(file, b);
    seen += b.length;
    fs.writeSync(1, `\r${"L".repeat(seen)}`);
  });
  fs.writeSync(1, READY);
} else if (role === "idle") {
  process.stdin.setRawMode(true);
  fs.writeSync(1, READY);
  setInterval(() => {}, 1000);
} else if (role === "parent") {
  const { master, child, ready } = start("child", [file]);
  await ready;
  const writer = ptyWriter(master);
  const total = Number(process.env.PUMP_BYTES);
  const input = Buffer.from(Array.from({ length: total }, (_, i) => 97 + (i % 26)));
  for (let off = 0; off < total; off += 1024) writer.write(input.subarray(off, off + 1024));
  while ((fs.existsSync(file) ? fs.statSync(file).size : 0) < total) await Bun.sleep(20);
  child.kill();
  process.exit(0);
} else if (role === "stop") {
  const { master, child, ready } = start("idle");
  await ready;
  const writer = await fillQueue(master);
  const stopping = writer.stop(4000);
  child.kill("SIGKILL");
  // Linux never wakes a master write blocked on a full queue when the slave
  // closes (reads get EIO, the write stays put), so stop declines and the
  // wrapper keeps the fd open: nothing can be reused, nothing to check.
  if (!(await stopping)) process.exit(process.platform === "linux" ? 0 : 3);
  fs.closeSync(master);
  const reused = fs.openSync(file, "w");
  if (reused !== master) process.exit(4); // the check below would prove nothing
  writer.write(Buffer.from("after stop"));
  await Bun.sleep(300);
  process.exit(fs.statSync(file).size === 0 ? 0 : 5);
} else if (role === "stuck") {
  const { master, child, ready } = start("idle");
  await ready;
  const writer = await fillQueue(master);
  const stopped = await writer.stop(100);
  child.kill("SIGKILL");
  process.exit(stopped ? 6 : 0);
}
