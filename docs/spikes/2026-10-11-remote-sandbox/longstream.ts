// Mirrors the hub's future puller: spawn `openshell sandbox exec` detached with
// stdin ignored, read stdout line by line, log arrival time, exit code and when
// the stream ended. Remote side prints a line after growing idle gaps.
const [gw, sbx, log] = Bun.argv.slice(2);
const gaps = [0, 60, 300, 600, 1200, 1800, 3600, 3600, 3600, 3600];
const remote = `for g in ${gaps.join(" ")}; do sleep $g; echo "$(date +%s) gap=$g"; done`;
const out = Bun.file(log).writer();
const w = (s: string) => { out.write(`${new Date().toISOString()} ${s}\n`); out.flush(); };
w(`start gaps=${gaps.join(",")}`);
const p = Bun.spawn(["openshell", "-g", gw, "sandbox", "exec", "-n", sbx, "--no-tty", "--", "bash", "-c", remote],
  { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
w(`openshell pid ${p.pid}`);
(async () => { for await (const c of p.stderr) w(`stderr ${new TextDecoder().decode(c).trim()}`); })();
let buf = "";
for await (const c of p.stdout) {
  buf += new TextDecoder().decode(c);
  let i; while ((i = buf.indexOf("\n")) >= 0) { w(`line ${buf.slice(0, i)}`); buf = buf.slice(i + 1); }
}
w(`exit code=${await p.exited} signal=${p.signalCode}`);
