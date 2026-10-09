import { test, expect } from "bun:test";
import {
  attachSettingsFrom, attachCtxFor, viewSessionName, groupedSessionName, buildViewClientArgv,
  buildGroupedSessionCommands, shellQuote, expandTemplate, nestedTmuxArgv, DEFAULT_ATTACH_SETTINGS,
} from "../src/attach-place.ts";

const C = { tmux_session: "work", tmux_window: "@3", tmux_pane: "%5", tmux_socket: "/tmp/tmux-501/default" };
const ID = "019f1898-8e0f-7000-ab55-07d09f673b59";

test("settings take config values and fill defaults", () => {
  expect(DEFAULT_ATTACH_SETTINGS.viewDetachKey).toBe("M-d");
  const s = attachSettingsFrom({ live: "new-window", terminal: { newWindow: ["x", "{cmd}"] } }, "/bin/agmux");
  expect(s).toEqual({ defaults: { live: "new-window", closed: undefined }, viewDetachKey: "M-d", terminal: { newWindow: ["x", "{cmd}"] }, agmuxBin: "/bin/agmux" });
});

test("attachCtxFor reads TMUX and the configured terminals", () => {
  const s = attachSettingsFrom({ terminal: { newTab: ["t", "{cmd}"] } }, "agmux");
  expect(attachCtxFor(s, { TMUX: "/tmp/x,1,0" }, true)).toEqual({ inTmux: true, popup: true, terminalWindow: false, terminalTab: true });
  expect(attachCtxFor(s, {}, false).inTmux).toBe(false);
});

test("names are derived from the session id prefix", () => {
  expect(groupedSessionName(ID)).toBe("agmux-019f1898");
  expect(viewSessionName(ID, 0)).toBe("agmux-view-019f1898-0");
  expect(viewSessionName(ID, 36)).toBe("agmux-view-019f1898-10");
});

test("view client: a second client on a throw-away grouped session that takes no keys", () => {
  expect(buildViewClientArgv(C, "V", "M-d")).toEqual([
    "env", "-u", "TMUX", "tmux", "-S", "/tmp/tmux-501/default",
    "new-session", "-t", "work", "-s", "V",
    ";", "set-option", "-t", "V", "destroy-unattached", "on",
    ";", "set-option", "-t", "V", "status", "off",
    ";", "set-option", "-t", "V", "prefix", "None",
    ";", "set-option", "-t", "V", "prefix2", "None",
    ";", "bind-key", "-T", "agmux-view", "M-d", "detach-client",
    ";", "set-option", "-t", "V", "key-table", "agmux-view",
    ";", "select-window", "-t", "V:@3",
    ";", "select-pane", "-t", "%5",
  ]);
});

test("view client without a pane or socket selects the window only", () => {
  const argv = buildViewClientArgv({ ...C, tmux_pane: null, tmux_socket: null }, "V", "M-d");
  expect(argv.slice(0, 5)).toEqual(["env", "-u", "TMUX", "tmux", "new-session"]);
  expect(argv.at(-1)).toBe("V:@3");
});

test("grouped session: create, switch, then mark ephemeral, then focus window and pane", () => {
  const S = ["-S", "/tmp/tmux-501/default"];
  expect(buildGroupedSessionCommands(C, "G", false)).toEqual([
    [...S, "new-session", "-d", "-t", "work", "-s", "G"],
    [...S, "switch-client", "-t", "G"],
    [...S, "set-option", "-t", "G", "destroy-unattached", "on"],
    [...S, "select-window", "-t", "G:@3"],
    [...S, "select-pane", "-t", "%5"],
  ]);
});

test("grouped session that already exists is only switched to and focused", () => {
  expect(buildGroupedSessionCommands({ ...C, tmux_pane: null, tmux_socket: null }, "G", true)).toEqual([
    ["switch-client", "-t", "G"],
    ["select-window", "-t", "G:@3"],
  ]);
});

test("shellQuote leaves safe words alone and single-quotes the rest", () => {
  expect(shellQuote("/usr/local/bin/agmux")).toBe("/usr/local/bin/agmux");
  expect(shellQuote("a b")).toBe("'a b'");
  expect(shellQuote("it's")).toBe("'it'\\''s'");
});

test("expandTemplate splices {cmd} as argv, or shell-quotes it inside a string", () => {
  const cmd = ["/Apps/My Tools/agmux", "attach", ID];
  expect(expandTemplate(["open", "-na", "Ghostty.app", "--args", "-e", "{cmd}"], cmd))
    .toEqual(["open", "-na", "Ghostty.app", "--args", "-e", "/Apps/My Tools/agmux", "attach", ID]);
  expect(expandTemplate(["osascript", "-e", "run {cmd}"], cmd))
    .toEqual(["osascript", "-e", `run '/Apps/My Tools/agmux' attach ${ID}`]);
});

test("nestedTmuxArgv escapes command separators so the outer tmux passes them through", () => {
  expect(nestedTmuxArgv(["tmux", "new-session", "-s", "V", ";", "set-option", "status", "off"]))
    .toEqual(["tmux", "new-session", "-s", "V", "\\;", "set-option", "status", "off"]);
});
