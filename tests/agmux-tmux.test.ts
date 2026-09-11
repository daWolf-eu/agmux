import { test, expect } from "bun:test";

async function callFn(fn: string, args: string[], env: Record<string, string> = {}): Promise<string> {
  const p = Bun.spawn(["bash", "-c", `AGMUX_TMUX_LIB_ONLY=1 source ./agmux.tmux; ${fn} ${args.join(" ")}`], {
    env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe",
  });
  return (await new Response(p.stdout).text()).trim();
}

test("status2 requires tmux >= 3.3", async () => {
  expect(await callFn("agmux_tmux_supports_status2", ["3.3a"])).toBe("yes");
  expect(await callFn("agmux_tmux_supports_status2", ["3.6a"])).toBe("yes");
  expect(await callFn("agmux_tmux_supports_status2", ["3.2"])).toBe("no");
  expect(await callFn("agmux_tmux_supports_status2", ["2.9"])).toBe("no");
});

test("requested status2 downgrades to status-right below 3.3", async () => {
  expect(await callFn("agmux_tmux_statusline_target", ["status2", "3.6a"])).toBe("status2");
  expect(await callFn("agmux_tmux_statusline_target", ["status2", "3.2"])).toBe("status-right");
  expect(await callFn("agmux_tmux_statusline_target", ["status-right", "3.6a"])).toBe("status-right");
  expect(await callFn("agmux_tmux_statusline_target", ["off", "3.6a"])).toBe("off");
});
