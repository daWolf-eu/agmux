// Runs the fixed remote attach scripts (packages/cli/src/remote-tmux.ts) locally
// against a real tmux server, under /bin/sh and, when installed, dash (CI's sh).
// A stub `tmux` first on PATH forwards everything to the real binary except
// `attach-session`, which it logs (pid + argv) and exits 0 on: the scripts'
// final `exec tmux … attach-session` needs a TTY we do not have.
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  viewSessionName, viewScriptArgv, fullScriptArgv, reapScriptArgv,
  REAP_FN, VIEW_SCRIPT, FULL_SCRIPT, REAP_SCRIPT,
} from "../packages/cli/src/remote-tmux.ts";

// Resolved before any PATH change: the stub forwards to this binary.
const REAL_TMUX = Bun.which("tmux");
const DASH = Bun.which("dash");
const SHELLS = ["/bin/sh", ...(DASH ? [DASH] : [])];

const ID = "019f1898-8e0f-7000-ab55-07d09f673b59";
const ID2 = "0a9f1898-8e0f-7000-ab55-07d09f673b59";

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

interface Env { dir: string; sock: string; home: string; st: string; bin: string; log: string }

function makeEnv(): Env {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agmux-rt-"));
  const env: Env = {
    dir, sock: path.join(dir, "inner.sock"), home: path.join(dir, "home"),
    st: path.join(dir, "home", ".agmux", "attach"), bin: path.join(dir, "bin"), log: path.join(dir, "attach.log"),
  };
  fs.mkdirSync(env.home);
  fs.mkdirSync(env.bin);
  fs.writeFileSync(path.join(env.bin, "tmux"), [
    "#!/bin/sh",
    'for a in "$@"; do',
    '  if [ "$a" = attach-session ]; then printf \'%s\\n\' "$$" "$@" > "$AGMUX_STUB_LOG"; exit 0; fi',
    "done",
    `exec ${shq(REAL_TMUX ?? "tmux")} "$@"`,
    "",
  ].join("\n"), { mode: 0o755 });
  return env;
}

function scriptEnv(e: Env): Record<string, string> {
  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    PATH: `${e.bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    HOME: e.home,
    // A tmux call without -S must never reach the developer's own server.
    TMUX_TMPDIR: e.dir,
    AGMUX_STUB_LOG: e.log,
  };
  delete env.TMUX;
  delete env.TMUX_PANE;
  return env;
}

async function tmux(e: Env, args: string[]): Promise<{ code: number; out: string }> {
  const p = Bun.spawn([REAL_TMUX!, "-S", e.sock, "-f", "/dev/null", ...args], {
    stdin: "ignore", stdout: "pipe", stderr: "pipe", env: scriptEnv(e),
  });
  const out = (await new Response(p.stdout).text()).trim();
  return { code: await p.exited, out };
}

async function run(shell: string, e: Env, argv: string[]): Promise<{ code: number; pid: number; err: string }> {
  expect(argv[0]).toBe("sh");
  const p = Bun.spawn([shell, ...argv.slice(1)], {
    cwd: e.dir, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: scriptEnv(e),
  });
  const err = await new Response(p.stderr).text();
  return { code: await p.exited, pid: p.pid, err };
}

const stubLog = (e: Env): string[] => fs.readFileSync(e.log, "utf8").replace(/\n$/, "").split("\n");
const state = (e: Env, tag: string): string => fs.readFileSync(path.join(e.st, tag), "utf8");

for (const shell of SHELLS) {
  describe.skipIf(!REAL_TMUX)(`remote scripts under ${shell}`, () => {
    let e: Env;
    let W = "";
    let P = "";

    beforeEach(async () => {
      e = makeEnv();
      expect((await tmux(e, ["new-session", "-d", "-s", "work", "sleep 600"])).code).toBe(0);
      // Keeps the server up once `work`'s only window is gone.
      await tmux(e, ["new-session", "-d", "-s", "keep", "sleep 600"]);
      W = (await tmux(e, ["display-message", "-p", "-t", "=work:", "#{window_id}"])).out;
      P = (await tmux(e, ["display-message", "-p", "-t", "=work:", "#{pane_id}"])).out;
    });

    afterEach(async () => {
      await tmux(e, ["kill-server"]);
      fs.rmSync(e.dir, { recursive: true, force: true });
    });

    const coords = () => ({ session: "work", window: W, pane: P, socket: e.sock });

    test("view setup links the agent window", async () => {
      const V = viewSessionName(ID, "p1");
      const r = await run(shell, e, viewScriptArgv(coords(), V, "M-d", "p1"));
      expect(r.err).toBe("");
      expect(r.code).toBe(0);
      expect((await tmux(e, ["list-windows", "-t", `=${V}`, "-F", "#{window_id}"])).out).toBe(W);
      expect((await tmux(e, ["show", "-t", V, "-v", "key-table"])).out).toBe("agmux-view");
      expect((await tmux(e, ["show", "-t", V, "-v", "prefix"])).out).toBe("None");
      expect((await tmux(e, ["show", "-t", V, "-v", "status"])).out).toBe("off");
      const keys = (await tmux(e, ["list-keys", "-T", "agmux-view"])).out;
      expect(keys).toMatch(/agmux-view\s+M-d\s+detach-client/);
      // The view's key table replaces root for mouse events too: tmux's defaults, rebound.
      expect(keys).toMatch(/agmux-view\s+MouseDown1Pane\s+select-pane -t = \\; send-keys -M/);
      expect(keys).toMatch(/agmux-view\s+MouseDrag1Pane\s+if-shell -F .*"copy-mode -M"/);
      expect(keys).toMatch(/agmux-view\s+WheelUpPane\s+if-shell -F .*"copy-mode -e"/);
      expect(state(e, "p1")).toBe(`view ${e.sock} ${V}\n`);
      expect(stubLog(e).slice(1)).toEqual([
        "-u", "-S", e.sock, "attach-session", "-t", `=${V}`, ";", "set", "-t", V, "destroy-unattached", "on",
      ]);
    });

    test("missing window exits 3 and leaves no view", async () => {
      const V = viewSessionName(ID, "p1");
      const r = await run(shell, e, viewScriptArgv({ ...coords(), window: "@99" }, V, "M-d", "p1"));
      expect(r.code).toBe(3);
      expect(r.err).toContain("@99 is gone");
      expect((await tmux(e, ["list-sessions", "-F", "#{session_name}"])).out).not.toContain("agmux-view-");
      expect(fs.existsSync(e.log)).toBe(false);
    });

    describe("server identity", () => {
      const MSG = "agmux: the sandbox tmux server restarted; the session's window is gone";
      const serverId = async () => (await tmux(e, ["display-message", "-p", "#{pid}-#{start_time}"])).out;
      const pidOnly = async () => (await tmux(e, ["display-message", "-p", "#{pid}"])).out;

      test("view: a different server id exits 3 before touching anything", async () => {
        const V = viewSessionName(ID, "p1");
        const r = await run(shell, e, viewScriptArgv({ ...coords(), server: "1-2" }, V, "M-d", "p1"));
        expect(r.code).toBe(3);
        expect(r.err.trim()).toBe(MSG);
        expect((await tmux(e, ["list-sessions", "-F", "#{session_name}"])).out).not.toContain("agmux-view-");
        expect(fs.existsSync(e.log)).toBe(false);
      });

      test("view: the matching id attaches as before", async () => {
        const V = viewSessionName(ID, "p1");
        const r = await run(shell, e, viewScriptArgv({ ...coords(), server: await serverId() }, V, "M-d", "p1"));
        expect(r.err).toBe("");
        expect(r.code).toBe(0);
        expect((await tmux(e, ["list-windows", "-t", `=${V}`, "-F", "#{window_id}"])).out).toBe(W);
      });

      test("view: a pid-only id compares the pid only", async () => {
        const V = viewSessionName(ID, "p1");
        expect((await run(shell, e, viewScriptArgv({ ...coords(), server: await pidOnly() }, V, "M-d", "p1"))).code).toBe(0);
        const bad = await run(shell, e, viewScriptArgv({ ...coords(), server: "1" }, V, "M-d", "p2"));
        expect(bad.code).toBe(3);
        expect(bad.err.trim()).toBe(MSG);
      });

      test("view: unknown or malformed id skips the check", async () => {
        for (const [i, server] of [null, undefined, "$(touch pwned)"].entries()) {
          const V = viewSessionName(ID, `p${i}`);
          const r = await run(shell, e, viewScriptArgv({ ...coords(), server }, V, "M-d", `p${i}`));
          expect(r.code).toBe(0);
        }
        expect(fs.existsSync(path.join(e.dir, "pwned"))).toBe(false);
      });

      test("full: mismatch exits 3, match and unknown attach", async () => {
        const bad = await run(shell, e, fullScriptArgv({ ...coords(), server: "1-2" }, "p1"));
        expect(bad.code).toBe(3);
        expect(bad.err.trim()).toBe(MSG);
        expect(fs.existsSync(e.log)).toBe(false);
        const ok = await run(shell, e, fullScriptArgv({ ...coords(), server: await serverId() }, "p2"));
        expect(ok.err).toBe("");
        expect(ok.code).toBe(0);
        expect((await run(shell, e, fullScriptArgv(coords(), "p3"))).code).toBe(0);
      });

      test("the server check runs before the window check", async () => {
        const r = await run(shell, e, fullScriptArgv({ ...coords(), window: "@99", server: "1-2" }, "p1"));
        expect(r.err.trim()).toBe(MSG);
      });
    });

    test("view: the state is recorded before the view is built", async () => {
      const V = viewSessionName(ID, "p1");
      // A session of that name already exists: new-session fails mid-build.
      expect((await tmux(e, ["new-session", "-d", "-s", V, "sleep 600"])).code).toBe(0);
      const r = await run(shell, e, viewScriptArgv(coords(), V, "M-d", "p1"));
      expect(r.code).toBe(3);
      expect(r.err).toContain("could not build the view");
      expect(state(e, "p1")).toBe(`view ${e.sock} ${V}\n`);
      expect((await run(shell, e, reapScriptArgv("p1"))).code).toBe(0);
      expect(fs.existsSync(path.join(e.st, "p1"))).toBe(false);
      expect((await tmux(e, ["has-session", "-t", "=work"])).code).toBe(0);
    });

    test("agent window killed → view session gone, server alive", async () => {
      const V = viewSessionName(ID, "p1");
      expect((await run(shell, e, viewScriptArgv(coords(), V, "M-d", "p1"))).code).toBe(0);
      expect((await tmux(e, ["kill-window", "-t", W])).code).toBe(0);
      expect((await tmux(e, ["has-session", "-t", `=${V}`])).code).not.toBe(0);
      const ls = await tmux(e, ["list-sessions", "-F", "#{session_name}"]);
      expect(ls.code).toBe(0);
      expect(ls.out).toBe("keep");
    });

    test("same tag reaps the previous client first", async () => {
      const V1 = viewSessionName(ID, "p1");
      const V2 = viewSessionName(ID2, "p1");
      expect((await run(shell, e, viewScriptArgv(coords(), V1, "M-d", "p1"))).code).toBe(0);
      expect((await run(shell, e, viewScriptArgv(coords(), V2, "M-d", "p1"))).code).toBe(0);
      expect((await tmux(e, ["has-session", "-t", `=${V1}`])).code).not.toBe(0);
      expect((await tmux(e, ["list-windows", "-t", `=${V2}`, "-F", "#{window_id}"])).out).toBe(W);
      expect(state(e, "p1")).toBe(`view ${e.sock} ${V2}\n`);
    });

    test("reap kills the view and clears the state", async () => {
      const V = viewSessionName(ID, "p1");
      expect((await run(shell, e, viewScriptArgv(coords(), V, "M-d", "p1"))).code).toBe(0);
      const r = await run(shell, e, reapScriptArgv("p1"));
      expect(r.code).toBe(0);
      expect((await tmux(e, ["has-session", "-t", `=${V}`])).code).not.toBe(0);
      expect(fs.existsSync(path.join(e.st, "p1"))).toBe(false);
      // The agent's own session is untouched.
      expect((await tmux(e, ["list-windows", "-t", "=work", "-F", "#{window_id}"])).out).toBe(W);
    });

    test("reap of an unknown tag is a no-op", async () => {
      expect((await run(shell, e, reapScriptArgv("p9"))).code).toBe(0);
    });

    test("full mode records the client pid and selects window and pane", async () => {
      const r = await run(shell, e, fullScriptArgv(coords(), "p1"));
      expect(r.err).toBe("");
      expect(r.code).toBe(0);
      expect(state(e, "p1")).toBe(`full ${e.sock} ${r.pid}\n`);
      const log = stubLog(e);
      expect(log[0]).toBe(String(r.pid)); // $$ is the pid that execs the client
      expect(log.slice(1)).toEqual([
        "-u", "-S", e.sock, "attach-session", "-t", "=work", ";", "select-window", "-t", W, ";", "select-pane", "-t", P,
      ]);
      expect(log.slice(-3)).toEqual(["select-pane", "-t", "%0"]);
    });

    test("full mode without a pane or socket ends at select-window", async () => {
      // No socket: the default server, which TMUX_TMPDIR points at a dir with none;
      // the window check fails there, so check the pane-less tail via our socket.
      const r = await run(shell, e, fullScriptArgv({ ...coords(), pane: null }, "p1"));
      expect(r.code).toBe(0);
      expect(stubLog(e).slice(-3)).toEqual(["select-window", "-t", W]);
      const n = await run(shell, e, fullScriptArgv({ ...coords(), socket: null }, "p2"));
      expect(n.code).toBe(3);
      expect(n.err).toContain(`${W} is gone`);
      expect(fs.existsSync(path.join(e.st, "p2"))).toBe(false);
    });

    test("full mode: missing window exits 3 before recording or attaching", async () => {
      const r = await run(shell, e, fullScriptArgv({ ...coords(), window: "@99" }, "p1"));
      expect(r.code).toBe(3);
      expect(r.err).toContain("@99 is gone");
      expect(fs.existsSync(path.join(e.st, "p1"))).toBe(false);
      expect(fs.existsSync(e.log)).toBe(false);
    });

    test("full reap kills the recorded pid only when it is a tmux attach client", async () => {
      const fake = path.join(e.dir, "fakebin");
      fs.mkdirSync(fake);
      // A tmux client: comm `tmux`, `attach-session` in its args (a shell stands in for it).
      fs.symlinkSync(DASH ?? Bun.which("bash")!, path.join(fake, "tmux"));
      fs.mkdirSync(path.join(fake, "srv"));
      // tmux by name only, no attach-session in its args (like the tmux server).
      fs.symlinkSync(Bun.which("sleep")!, path.join(fake, "srv", "tmux"));
      const client = Bun.spawn([path.join(fake, "tmux"), "-c", "trap 'exit 0' TERM; while :; do sleep 1; done", "attach-session"], { stdin: "ignore" });
      const named = Bun.spawn([path.join(fake, "srv", "tmux"), "600"], { stdin: "ignore" });
      const other = Bun.spawn([Bun.which("sleep")!, "600"], { stdin: "ignore" });
      try {
        await Bun.sleep(100);
        fs.mkdirSync(e.st, { recursive: true });
        fs.writeFileSync(path.join(e.st, "p1"), `full - ${client.pid}\n`);
        fs.writeFileSync(path.join(e.st, "p2"), `full - ${other.pid}\n`);
        fs.writeFileSync(path.join(e.st, "p3"), `full - ${named.pid}\n`);
        for (const tag of ["p1", "p2", "p3"]) expect((await run(shell, e, reapScriptArgv(tag))).code).toBe(0);
        expect(await Promise.race([client.exited.then(() => "dead"), Bun.sleep(3000).then(() => "alive")])).toBe("dead");
        const alive = (p: Bun.Subprocess) => Promise.race([p.exited.then(() => "dead"), Bun.sleep(500).then(() => "alive")]);
        expect(await alive(other)).toBe("alive");
        expect(await alive(named)).toBe("alive");
        for (const tag of ["p1", "p2", "p3"]) expect(fs.existsSync(path.join(e.st, tag))).toBe(false);
      } finally {
        client.kill();
        named.kill();
        other.kill();
      }
    });

    test("full reap never kills the tmux server (pid reuse)", async () => {
      const pid = (await tmux(e, ["display-message", "-p", "#{pid}"])).out;
      expect(pid).toMatch(/^\d+$/);
      fs.mkdirSync(e.st, { recursive: true });
      fs.writeFileSync(path.join(e.st, "p1"), `full - ${pid}\n`);
      expect((await run(shell, e, reapScriptArgv("p1"))).code).toBe(0);
      await Bun.sleep(200);
      expect((await tmux(e, ["has-session", "-t", "=work"])).code).toBe(0);
      expect(fs.existsSync(path.join(e.st, "p1"))).toBe(false);
    });

    test("reap never interprets the state file", async () => {
      const lines = ["view - $(touch pwned)", "full - $(touch pwned)", "view $(touch pwned) `touch pwned`"];
      for (const line of lines) {
        fs.mkdirSync(e.st, { recursive: true });
        fs.writeFileSync(path.join(e.st, "p1"), `${line}\n`);
        const r = await run(shell, e, reapScriptArgv("p1"));
        expect(r.code).toBe(0);
        const found = (fs.readdirSync(e.dir, { recursive: true }) as string[]).filter((f) => path.basename(f) === "pwned");
        expect(found).toEqual([]);
        expect(fs.existsSync(path.join(e.st, "p1"))).toBe(false);
      }
    });
  });
}

// ---- static safety: positional args are never interpreted ------------------

interface Word { text: string; unquoted: boolean } // unquoted: holds a `$` outside double quotes

// A small sh word splitter, enough for the scripts' own text: quotes,
// backslash escapes, `${…}` / `$(…)` (whose bodies are checked recursively),
// comments and operators. Returns the words and every substitution body found.
function shWords(src: string, subs: string[] = []): Word[] {
  const words: Word[] = [];
  let cur = "";
  let unq = false;
  let i = 0;
  const flush = () => { if (cur) words.push({ text: cur, unquoted: unq }); cur = ""; unq = false; };
  const closing = (j: number, open: string, close: string): number => {
    let depth = 1, k = j, sq = false, dq = false;
    for (; k < src.length; k++) {
      const c = src[k];
      if (sq) { if (c === "'") sq = false; continue; }
      if (c === "\\") { k++; continue; }
      if (c === "'" && !dq) sq = true;
      else if (c === '"') dq = !dq;
      else if (!dq && c === open) depth++;
      else if (!dq && c === close && --depth === 0) return k;
    }
    throw new Error(`unclosed ${open} in ${src}`);
  };
  // Consumes a `$…` expansion at i; returns its text.
  const dollar = (): string => {
    const start = i;
    i++;
    if (src[i] === "(" || src[i] === "{") {
      const end = closing(i + 1, src[i]!, src[i] === "(" ? ")" : "}");
      if (src[i] === "(") subs.push(src.slice(i + 1, end));
      i = end + 1;
    } else {
      if (/[0-9@*#?$!-]/.test(src[i] ?? "")) i++;
      else while (i < src.length && /[A-Za-z0-9_]/.test(src[i]!)) i++;
    }
    return src.slice(start, i);
  };
  while (i < src.length) {
    const c = src[i]!;
    if (c === "\\") { if (src[i + 1] !== "\n") cur += src.slice(i, i + 2); i += 2; continue; }
    if (c === "'") { const end = src.indexOf("'", i + 1); cur += src.slice(i, end + 1); i = end + 1; continue; }
    if (c === '"') {
      let k = i + 1;
      cur += '"';
      while (src[k] !== '"') {
        if (src[k] === "\\") { cur += src.slice(k, k + 2); k += 2; continue; }
        if (src[k] === "$") { i = k; cur += dollar(); k = i; continue; }
        if (src[k] === "`") throw new Error("backquotes are not allowed");
        cur += src[k++];
      }
      cur += '"';
      i = k + 1;
      continue;
    }
    if (c === "$") { unq = true; cur += dollar(); continue; }
    if (c === "`") throw new Error("backquotes are not allowed");
    if (c === "#" && cur === "") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (/[\s;&|()<>]/.test(c)) { flush(); i++; continue; }
    cur += c;
    i++;
  }
  flush();
  return words;
}

// Words whose `$` is subject to field splitting / globbing: anything but an
// assignment or the word of a `case`.
function unquotedExpansions(src: string): string[] {
  const bad: string[] = [];
  const queue = [src];
  while (queue.length) {
    const subs: string[] = [];
    const ws = shWords(queue.shift()!, subs);
    ws.forEach((w, n) => {
      if (!w.unquoted) return;
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w.text)) return;
      if (ws[n - 1]?.text === "case") return;
      bad.push(w.text);
    });
    queue.push(...subs);
  }
  return bad;
}

describe("positional args are never interpreted", () => {
  const scripts = { VIEW_SCRIPT, FULL_SCRIPT, REAP_SCRIPT };

  test("the checker itself flags unquoted expansions", () => {
    expect(unquotedExpansions(`tmux -S $sock kill-session -t "=$x"`)).toEqual(["$sock"]);
    expect(unquotedExpansions(`kill $(cat "$f")`)).toEqual(["$(cat \"$f\")"]);
    expect(unquotedExpansions(`printf '%s' "$(echo $y)"`)).toEqual(["$y"]);
    expect(unquotedExpansions(`a=$1 b=$2\ncase $m in x) rm -f "$f" ;; esac`)).toEqual([]);
  });

  for (const [name, text] of Object.entries(scripts)) {
    test(`${name}: no eval`, () => {
      expect(text).not.toMatch(/\beval\b/);
    });

    test(`${name}: every expansion outside assignments and case words is double-quoted`, () => {
      expect(unquotedExpansions(text)).toEqual([]);
    });

    test(`${name}: $1…$9 appear only on the leading assignment line`, () => {
      expect(text.split(REAP_FN).length).toBe(2);
      const body = text.replace(REAP_FN, "").split("\n").filter((l) => l.trim() !== "");
      const first = body[0]!;
      if (name === "REAP_SCRIPT") {
        expect(first).toBe("sock=");
        expect(body.filter((l) => /\$\{?[0-9]/.test(l))).toEqual(['reap "$1"']);
      } else {
        expect(first).toMatch(/^[a-z]+=\$[1-9]( [a-z]+=\$[1-9])*$/);
        expect(body.slice(1).filter((l) => /\$\{?[0-9]/.test(l))).toEqual([]);
      }
    });
  }
});
