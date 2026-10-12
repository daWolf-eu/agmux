import { test, expect } from "bun:test";
import { readTmuxWidth } from "../src/statusline-width.ts";

const SEP = "\x1f";

// A fake tmux: `display -p` with the option fields answers from `opts`, any
// other `display -p` expands the format via `expand`, `list-clients` gives widths.
function fakeTmux(opts: Record<string, string>, clients: number[], expand: (f: string) => string = (f) => f) {
  const calls: string[][] = [];
  const capture = async (_cmd: string, args: string[]): Promise<string> => {
    calls.push(args);
    if (args[0] === "list-clients") return clients.map((w) => `${w}\n`).join("");
    const fmt = args[2]!;
    if (fmt.includes(SEP)) {
      const keys = [...fmt.matchAll(/#\{([^}]+)\}/g)].map((m) => m[1]!);
      return keys.map((k) => opts[k] ?? "").join(SEP) + "\n";
    }
    return expand(fmt) + "\n";
  };
  return { capture, calls };
}

test("chips in status-right: its length less the rest of status-right", async () => {
  const t = fakeTmux({ "status-right": "#{E:@agmux-chips} ", "status-right-length": "100" }, [277]);
  expect(await readTmuxWidth(t.capture)).toBe(99);
});

test("the narrowest client caps the side's length", async () => {
  const t = fakeTmux({ "status-right": "#{E:@agmux-chips}", "status-right-length": "200" }, [277, 120]);
  expect(await readTmuxWidth(t.capture)).toBe(120);
});

test("the rest of the side is expanded by tmux and measured without its styles", async () => {
  const t = fakeTmux(
    { "status-right": "#{E:@agmux-chips}#[fg=red] #{host}", "status-right-length": "100" }, [277],
    (f) => f.replace("#{host}", "mbp"),
  );
  expect(await readTmuxWidth(t.capture)).toBe(96);
});

test("chips in status-left use the left length", async () => {
  const t = fakeTmux({ "status-left": "#{E:@agmux-chips}", "status-left-length": "40", "status-right-length": "100" }, [277]);
  expect(await readTmuxWidth(t.capture)).toBe(40);
});

test("chips on their own status line (status2) get the narrowest client's width", async () => {
  const t = fakeTmux({ "status-format[1]": "#{E:@agmux-chips}" }, [150, 277]);
  expect(await readTmuxWidth(t.capture)).toBe(150);
});

test("@agmux-statusline-width wins over everything", async () => {
  const t = fakeTmux({ "@agmux-statusline-width": "60", "status-right": "#{E:@agmux-chips}", "status-right-length": "200" }, []);
  expect(await readTmuxWidth(t.capture)).toBe(60);
});

test("no limit when the chips' place is unknown, no client is attached, or tmux isn't there", async () => {
  expect(await readTmuxWidth(fakeTmux({ "status-right": "%H:%M", "status-right-length": "40" }, [277]).capture)).toBeUndefined();
  expect(await readTmuxWidth(fakeTmux({ "status-right": "#{E:@agmux-chips}", "status-right-length": "40" }, []).capture)).toBeUndefined();
  expect(await readTmuxWidth(async () => { throw new Error("no server"); })).toBeUndefined();
});
