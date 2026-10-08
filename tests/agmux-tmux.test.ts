import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Absolute, never "./agmux.tmux": run-shell jobs run in the tmux server's
// directory, not the test's, and a failed `source` there is silent — the test
// just sees no effect.
const PLUGIN = path.resolve(import.meta.dir, "../agmux.tmux");

async function callFn(fn: string, args: string[], env: Record<string, string> = {}): Promise<string> {
  const p = Bun.spawn(["bash", "-c", `AGMUX_TMUX_LIB_ONLY=1 source '${PLUGIN}'; ${fn} ${args.join(" ")}`], {
    env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe",
  });
  return (await new Response(p.stdout).text()).trim();
}

// -f /dev/null: each test's server starts from tmux defaults, never from the
// developer's own tmux.conf (only the first command of a server reads it).
async function tmuxCmd(socket: string, args: string[]): Promise<string> {
  const p = Bun.spawn(["tmux", "-L", socket, "-f", "/dev/null", ...args], {
    stdout: "pipe", stderr: "pipe",
  });
  return (await new Response(p.stdout).text()).trim();
}

// run-shell hands its command to /bin/sh, which is dash on Debian/Ubuntu (CI):
// no `source`, so the scripts below would die on their first line. Run them
// with bash explicitly, as TPM does via agmux.tmux's shebang.
async function tmuxRunShell(socket: string, script: string): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agmux-tmux-test-"));
  const file = path.join(dir, "script.bash");
  fs.writeFileSync(file, script);
  try {
    const p = Bun.spawn(["tmux", "-L", socket, "-f", "/dev/null", "run-shell", `bash '${file}'`], {
      stdout: "pipe", stderr: "pipe",
    });
    return (await new Response(p.stdout).text()).trim();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
  expect(await callFn("agmux_tmux_statusline_target", ["inline", "3.2"])).toBe("inline");
});

test("with @agmux-statusline off/unset, nothing is set", async () => {
  const socket = `agmux-test-off-${Date.now()}-${Math.random()}`;
  try {
    // Start a new server with a session
    await tmuxCmd(socket, ["new-session", "-d", "-s", "main"]);

    // Run the install function with statusline off and check nothing changes
    const script = `
      AGMUX_TMUX_LIB_ONLY=1 source '${PLUGIN}'
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
      AGMUX_TMUX_LIB_ONLY=1 source '${PLUGIN}'
      agmux_tmux_install_statusline "agmux" "status2" "2" "on" "3.6a"
    `;

    await tmuxRunShell(socket, script);

    // Verify status is now 2
    const status = await tmuxCmd(socket, ["show-option", "-gv", "status"]);
    expect(status).toBe("2");

    // status-format[1] shows @agmux-chips, which reads the cache file
    const format1 = await tmuxCmd(socket, ["show-option", "-gv", "status-format[1]"]);
    expect(format1).toBe("#{E:@agmux-chips}");
    const chips = await tmuxCmd(socket, ["show-option", "-gv", "@agmux-chips"]);
    expect(chips).toContain("cat");
    expect(chips).toContain("statusline");
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
      AGMUX_TMUX_LIB_ONLY=1 source '${PLUGIN}'
      agmux_tmux_install_statusline "agmux" "status2" "2" "on" "3.2"
    `;

    await tmuxRunShell(socket, script);

    // Verify status is still "on" (not 2)
    const status = await tmuxCmd(socket, ["show-option", "-gv", "status"]);
    expect(status).toBe("on");

    // Verify status-right is set with the cache path
    const statusRight = await tmuxCmd(socket, ["show-option", "-gv", "status-right"]);
    expect(statusRight).toBe("#{E:@agmux-chips}");
  } finally {
    await tmuxCmd(socket, ["kill-server"]);
  }
});

test("agmux_tmux_config_defaults falls back to hardcoded defaults when the binary is missing", async () => {
  const out = await callFn("agmux_tmux_config_defaults", ["/no/such/agmux-binary"]);
  expect(out).toBe("off\nstatus2");
});

test("agmux_tmux_config_defaults reads enabled/position from --print-config output", async () => {
  const fakeBin = `${import.meta.dir}/../.tmp-fake-agmux-config`;
  await Bun.write(fakeBin, "#!/bin/sh\necho 'enabled=true'\necho 'position=status-right'\n");
  await Bun.spawn(["chmod", "+x", fakeBin]).exited;
  try {
    const out = await callFn("agmux_tmux_config_defaults", [fakeBin]);
    expect(out).toBe("on\nstatus-right");
  } finally {
    await Bun.spawn(["rm", "-f", fakeBin]).exited;
  }
});

test("config.toml position is used as the default when @agmux-statusline-position is unset", async () => {
  const socket = `agmux-test-cfgpos-unset-${Date.now()}-${Math.random()}`;
  const fakeBin = `${import.meta.dir}/../.tmp-fake-agmux-unset-${Date.now()}`;
  try {
    await Bun.write(fakeBin, "#!/bin/sh\necho 'enabled=true'\necho 'position=status-right'\n");
    await Bun.spawn(["chmod", "+x", fakeBin]).exited;

    await tmuxCmd(socket, ["new-session", "-d", "-s", "main"]);
    await tmuxCmd(socket, ["set-option", "-g", "@agmux-bin", fakeBin]);
    // @agmux-statusline-position deliberately left unset.

    const script = `
      AGMUX_TMUX_LIB_ONLY=1 source '${PLUGIN}'
      main
    `;
    await tmuxRunShell(socket, script);

    const status = await tmuxCmd(socket, ["show-option", "-gv", "status-right"]);
    expect(status).toBe("#{E:@agmux-chips}");
  } finally {
    await tmuxCmd(socket, ["kill-server"]);
    await Bun.spawn(["rm", "-f", fakeBin]).exited;
  }
});

test("an explicit @agmux-statusline-position tmux option overrides config.toml's value", async () => {
  const socket = `agmux-test-cfgpos-override-${Date.now()}-${Math.random()}`;
  const fakeBin = `${import.meta.dir}/../.tmp-fake-agmux-override-${Date.now()}`;
  try {
    // Fake binary's config says status-right, but the tmux option below says off.
    await Bun.write(fakeBin, "#!/bin/sh\necho 'enabled=true'\necho 'position=status-right'\n");
    await Bun.spawn(["chmod", "+x", fakeBin]).exited;

    await tmuxCmd(socket, ["new-session", "-d", "-s", "main"]);
    await tmuxCmd(socket, ["set-option", "-g", "@agmux-bin", fakeBin]);
    await tmuxCmd(socket, ["set-option", "-g", "@agmux-statusline", "on"]);
    await tmuxCmd(socket, ["set-option", "-g", "@agmux-statusline-position", "off"]);

    const script = `
      AGMUX_TMUX_LIB_ONLY=1 source '${PLUGIN}'
      main
    `;
    await tmuxRunShell(socket, script);

    // "off" wins over the config-file "status-right": neither status2 nor
    // status-right get the agmux cache command installed.
    const status = await tmuxCmd(socket, ["show-option", "-gv", "status"]);
    expect(status).toBe("on");
    const format1 = await tmuxCmd(socket, ["show-option", "-gv", "status-format[1]"]);
    expect(format1).not.toContain("agmux");
    const statusRight = await tmuxCmd(socket, ["show-option", "-gv", "status-right"]);
    expect(statusRight).not.toContain("agmux");
  } finally {
    await tmuxCmd(socket, ["kill-server"]);
    await Bun.spawn(["rm", "-f", fakeBin]).exited;
  }
});

test("config.toml enabled=true turns the status line on even though @agmux-statusline defaults to off", async () => {
  const socket = `agmux-test-cfgenabled-${Date.now()}-${Math.random()}`;
  const fakeBin = `${import.meta.dir}/../.tmp-fake-agmux-enabled-${Date.now()}`;
  try {
    await Bun.write(fakeBin, "#!/bin/sh\necho 'enabled=true'\necho 'position=status-right'\n");
    await Bun.spawn(["chmod", "+x", fakeBin]).exited;

    await tmuxCmd(socket, ["new-session", "-d", "-s", "main"]);
    await tmuxCmd(socket, ["set-option", "-g", "@agmux-bin", fakeBin]);
    // @agmux-statusline deliberately left unset — config.toml's enabled=true should win.

    const script = `
      AGMUX_TMUX_LIB_ONLY=1 source '${PLUGIN}'
      main
    `;
    await tmuxRunShell(socket, script);

    const statusRight = await tmuxCmd(socket, ["show-option", "-gv", "status-right"]);
    expect(statusRight).toBe("#{E:@agmux-chips}");
  } finally {
    await tmuxCmd(socket, ["kill-server"]);
    await Bun.spawn(["rm", "-f", fakeBin]).exited;
  }
});

test("main() binds @agmux-mark-read-key (default u) to a quoted-$bin seen --pane command", async () => {
  const socket = `agmux-test-markread-${Date.now()}-${Math.random()}`;
  try {
    await tmuxCmd(socket, ["new-session", "-d", "-s", "main"]);

    const script = `
      AGMUX_TMUX_LIB_ONLY=1 source '${PLUGIN}'
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
      AGMUX_TMUX_LIB_ONLY=1 source '${PLUGIN}'
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

test("focus-seen installs focus-events and a namespaced pane-focus-in hook", async () => {
  const socket = `agmux-test-focus-${Date.now()}-${Math.random()}`;
  try {
    await tmuxCmd(socket, ["new-session", "-d", "-s", "main"]);
    await tmuxCmd(socket, ["set-option", "-g", "focus-events", "off"]);
    await tmuxRunShell(socket, `
      AGMUX_TMUX_LIB_ONLY=1 source '${PLUGIN}'
      agmux_tmux_install_focus_seen "/opt/agmux"
    `);
    expect(await tmuxCmd(socket, ["show-option", "-gv", "focus-events"])).toBe("on");
    const hooks = await tmuxCmd(socket, ["show-hooks", "-gw"]); // pane hooks live in the window scope
    const line = hooks.split("\n").find((l) => l.startsWith("pane-focus-in[99]")) ?? "";
    expect(line).toContain("run-shell -b");
    expect(line).toContain("/opt/agmux");
    expect(line).toContain("seen --pane");
    expect(line).toContain("--source focus");
  } finally {
    await tmuxCmd(socket, ["kill-server"]);
  }
});

test("status-line clicks on @ chips go to `statusline --click`; other clicks keep tmux's binding", async () => {
  const socket = `agmux-test-click-${Date.now()}-${Math.random()}`;
  try {
    await tmuxCmd(socket, ["new-session", "-d", "-s", "main"]);
    const install = `
      AGMUX_TMUX_LIB_ONLY=1 source '${PLUGIN}'
      agmux_tmux_install_statusline "/opt/my bin/agmux" "status2" "2" "on" "3.6a"
    `;
    await tmuxRunShell(socket, install);
    // Sourcing twice must not wrap our own binding as the "original".
    await tmuxRunShell(socket, install);

    const left = await tmuxCmd(socket, ["list-keys", "-T", "root", "MouseDown1Status"]);
    expect(left).toContain("if-shell -F \"#{m:@*,#{mouse_status_range}}\"");
    expect(left).toContain("run-shell -b \\\"'/opt/my bin/agmux' statusline --click left '#{mouse_status_range}';");
    expect(left).toContain("tmux refresh-client -S -t '#{client_name}'");
    // The else branch is whatever this tmux version binds by default.
    const dflt = (await callFn("agmux_tmux_default_binding", ["MouseDown1Status"])).replace(/"/g, '\\"');
    expect(dflt).toMatch(/^(switch-client|select-window) -t =$/);
    expect(left.endsWith(`"${dflt}"`)).toBe(true);
    expect(left.match(/statusline --click/g)?.length).toBe(1);

    const right = await tmuxCmd(socket, ["list-keys", "-T", "root", "MouseDown3Status"]);
    expect(right).toContain("statusline --click right");
    expect(right).toContain("display-menu"); // tmux's window menu, still there outside our chips
  } finally {
    await tmuxCmd(socket, ["kill-server"]);
  }
});

test("@agmux-statusline-mouse off leaves the status-line mouse bindings alone", async () => {
  const socket = `agmux-test-click-off-${Date.now()}-${Math.random()}`;
  try {
    await tmuxCmd(socket, ["new-session", "-d", "-s", "main"]);
    await tmuxRunShell(socket, `
      AGMUX_TMUX_LIB_ONLY=1 source '${PLUGIN}'
      agmux_tmux_install_statusline "agmux" "status2" "2" "off" "3.6a"
    `);
    expect(await tmuxCmd(socket, ["list-keys", "-T", "root", "MouseDown1Status"])).not.toContain("agmux");
    expect(await tmuxCmd(socket, ["list-keys", "-T", "root", "MouseDown3Status"])).not.toContain("agmux");
  } finally {
    await tmuxCmd(socket, ["kill-server"]);
  }
});

test("an old agmux MouseDown1Status binding falls back to tmux's default, not to nothing", async () => {
  const socket = `agmux-test-click-upgrade-${Date.now()}-${Math.random()}`;
  try {
    await tmuxCmd(socket, ["new-session", "-d", "-s", "main"]);
    await tmuxCmd(socket, ["bind-key", "-T", "root", "MouseDown1Status", "run-shell",
      "if [ -n '#{mouse_status_range}' ]; then 'agmux' attach '#{mouse_status_range}'; fi"]);
    await tmuxRunShell(socket, `
      AGMUX_TMUX_LIB_ONLY=1 source '${PLUGIN}'
      agmux_tmux_install_statusline "agmux" "status2" "2" "on" "3.6a"
    `);
    const left = await tmuxCmd(socket, ["list-keys", "-T", "root", "MouseDown1Status"]);
    const dflt = await callFn("agmux_tmux_default_binding", ["MouseDown1Status"]);
    expect(left.endsWith(`"${dflt}"`)).toBe(true);
    expect(left).not.toContain("attach");
  } finally {
    await tmuxCmd(socket, ["kill-server"]);
  }
});

test("inline sets @agmux-chips and the click bindings but leaves the status bar alone", async () => {
  const socket = `agmux-test-inline-${Date.now()}-${Math.random()}`;
  try {
    await tmuxCmd(socket, ["new-session", "-d", "-s", "main"]);
    await tmuxCmd(socket, ["set-option", "-g", "status-right", "mine"]);
    await tmuxRunShell(socket, `
      AGMUX_TMUX_LIB_ONLY=1 source '${PLUGIN}'
      agmux_tmux_install_statusline "agmux" "inline" "2" "on" "3.6a"
    `);
    expect(await tmuxCmd(socket, ["show-option", "-gv", "@agmux-chips"])).toContain("cat");
    expect(await tmuxCmd(socket, ["show-option", "-gv", "status"])).toBe("on");
    expect(await tmuxCmd(socket, ["show-option", "-gv", "status-right"])).toBe("mine");
    expect(await tmuxCmd(socket, ["list-keys", "-T", "root", "MouseDown1Status"])).toContain("statusline --click left");
  } finally {
    await tmuxCmd(socket, ["kill-server"]);
  }
});

test("unbound status mouse keys don't abort the plugin under set -e", async () => {
  const socket = `agmux-test-click-unbound-${Date.now()}-${Math.random()}`;
  try {
    await tmuxCmd(socket, ["new-session", "-d", "-s", "main"]);
    await tmuxCmd(socket, ["unbind-key", "-T", "root", "MouseDown1Status"]);
    await tmuxCmd(socket, ["unbind-key", "-T", "root", "MouseDown3Status"]);
    await tmuxRunShell(socket, `
      set -euo pipefail
      AGMUX_TMUX_LIB_ONLY=1 source '${PLUGIN}'
      agmux_tmux_install_statusline "agmux" "inline" "2" "on" "3.6a"
      tmux set-option -g @agmux-test-done yes
    `);
    expect(await tmuxCmd(socket, ["show-option", "-gv", "@agmux-test-done"])).toBe("yes");
    const left = await tmuxCmd(socket, ["list-keys", "-T", "root", "MouseDown1Status"]);
    expect(left).toContain("statusline --click left");
    expect(left.endsWith("'#{client_name}'\\\"\"")).toBe(true); // no else branch
  } finally {
    await tmuxCmd(socket, ["kill-server"]);
  }
});
