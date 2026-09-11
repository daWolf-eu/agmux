import { test, expect } from "bun:test";

async function callFn(fn: string, args: string[], env: Record<string, string> = {}): Promise<string> {
  const p = Bun.spawn(["bash", "-c", `AGMUX_TMUX_LIB_ONLY=1 source ./agmux.tmux; ${fn} ${args.join(" ")}`], {
    env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe",
  });
  return (await new Response(p.stdout).text()).trim();
}

async function tmuxCmd(socket: string, args: string[]): Promise<string> {
  const p = Bun.spawn(["tmux", "-L", socket, ...args], {
    stdout: "pipe", stderr: "pipe",
  });
  return (await new Response(p.stdout).text()).trim();
}

async function tmuxRunShell(socket: string, script: string): Promise<string> {
  const p = Bun.spawn(["tmux", "-L", socket, "run-shell", script], {
    stdout: "pipe", stderr: "pipe",
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

test("with @agmux-statusline off/unset, nothing is set", async () => {
  const socket = `agmux-test-off-${Date.now()}-${Math.random()}`;
  try {
    // Start a new server with a session
    await tmuxCmd(socket, ["new-session", "-d", "-s", "main"]);

    // Run the install function with statusline off and check nothing changes
    const script = `
      AGMUX_TMUX_LIB_ONLY=1 source ./agmux.tmux
      agmux_tmux_install_statusline "agmux" "off" "2" "on" "3.6a"
    `;

    await tmuxRunShell(socket, script);

    // Verify status is still "on" (default) and no status-format[1]
    const status = await tmuxCmd(socket, ["show-option", "-gv", "status"]);
    expect(status).toBe("on");

    // status-format[1] should be empty (not set)
    const format1 = await tmuxCmd(socket, ["show-option", "-gv", "status-format[1]"]);
    expect(format1).not.toContain("agmux");
  } finally {
    await tmuxCmd(socket, ["kill-server"]);
  }
});

test("with @agmux-statusline on and tmux >= 3.3, status becomes 2", async () => {
  const socket = `agmux-test-on33-${Date.now()}-${Math.random()}`;
  try {
    // Start a new server
    await tmuxCmd(socket, ["new-session", "-d", "-s", "main"]);

    // Run the install function with version 3.6a (>= 3.3)
    const script = `
      AGMUX_TMUX_LIB_ONLY=1 source ./agmux.tmux
      agmux_tmux_install_statusline "agmux" "status2" "2" "on" "3.6a"
    `;

    await tmuxRunShell(socket, script);

    // Verify status is now 2
    const status = await tmuxCmd(socket, ["show-option", "-gv", "status"]);
    expect(status).toBe("2");

    // Verify status-format[1] is set with the cache path
    const format1 = await tmuxCmd(socket, ["show-option", "-gv", "status-format[1]"]);
    expect(format1).toContain("cat");
    expect(format1).toContain("statusline");
  } finally {
    await tmuxCmd(socket, ["kill-server"]);
  }
});

test("with @agmux-statusline on and tmux < 3.3, uses status-right instead", async () => {
  const socket = `agmux-test-on32-${Date.now()}-${Math.random()}`;
  try {
    // Start a new server
    await tmuxCmd(socket, ["new-session", "-d", "-s", "main"]);

    // Run the install function with version 3.2 (< 3.3)
    const script = `
      AGMUX_TMUX_LIB_ONLY=1 source ./agmux.tmux
      agmux_tmux_install_statusline "agmux" "status2" "2" "on" "3.2"
    `;

    await tmuxRunShell(socket, script);

    // Verify status is still "on" (not 2)
    const status = await tmuxCmd(socket, ["show-option", "-gv", "status"]);
    expect(status).toBe("on");

    // Verify status-right is set with the cache path
    const statusRight = await tmuxCmd(socket, ["show-option", "-gv", "status-right"]);
    expect(statusRight).toContain("cat");
    expect(statusRight).toContain("statusline");
  } finally {
    await tmuxCmd(socket, ["kill-server"]);
  }
});

test("main() binds @agmux-mark-read-key (default u) to a quoted-$bin seen --pane command", async () => {
  const socket = `agmux-test-markread-${Date.now()}-${Math.random()}`;
  try {
    await tmuxCmd(socket, ["new-session", "-d", "-s", "main"]);

    const script = `
      AGMUX_TMUX_LIB_ONLY=1 source ./agmux.tmux
      main
    `;
    await tmuxRunShell(socket, script);

    const binding = await tmuxCmd(socket, ["list-keys", "-T", "prefix", "u"]);
    expect(binding).toContain("run-shell");
    expect(binding).toContain("seen --pane");
    // A previous review found an unquoted $bin breaks for binary paths with
    // spaces — assert the bound command quotes the binary.
    expect(binding).toContain("'agmux' seen --pane");
  } finally {
    await tmuxCmd(socket, ["kill-server"]);
  }
});

test("@agmux-mark-read-key overrides the default binding key and honors a custom @agmux-bin", async () => {
  const socket = `agmux-test-markread-custom-${Date.now()}-${Math.random()}`;
  try {
    await tmuxCmd(socket, ["new-session", "-d", "-s", "main"]);
    await tmuxCmd(socket, ["set-option", "-g", "@agmux-mark-read-key", "M"]);
    await tmuxCmd(socket, ["set-option", "-g", "@agmux-bin", "/opt/my bin/agmux"]);

    const script = `
      AGMUX_TMUX_LIB_ONLY=1 source ./agmux.tmux
      main
    `;
    await tmuxRunShell(socket, script);

    const defaultBinding = await tmuxCmd(socket, ["list-keys", "-T", "prefix", "u"]);
    expect(defaultBinding).not.toContain("seen --pane");

    const binding = await tmuxCmd(socket, ["list-keys", "-T", "prefix", "M"]);
    expect(binding).toContain("seen --pane");
    expect(binding).toContain("'/opt/my bin/agmux' seen --pane");
  } finally {
    await tmuxCmd(socket, ["kill-server"]);
  }
});
