import { test, expect } from "bun:test";
import {
  attachSettingsFrom, attachCtxFor, resumeSessionName, shellQuote, expandTemplate,
} from "../src/attach-place.ts";

const ID = "019f1898-8e0f-7000-ab55-07d09f673b59";

test("settings take config values and fill defaults", () => {
  const s = attachSettingsFrom({ live: "new-window", terminal: { newWindow: ["x", "{cmd}"] }, remote: {} }, "/bin/agmux");
  expect(s).toEqual({ defaults: { live: "new-window", closed: undefined, remote: undefined }, terminal: { newWindow: ["x", "{cmd}"] },
    remote: { placement: "new-window", mode: "view", windowName: "⇄ {title}", detachKey: "M-d" }, agmuxBin: "/bin/agmux" });
});

test("attachCtxFor reads TMUX and the configured terminals", () => {
  const s = attachSettingsFrom({ terminal: { newTab: ["t", "{cmd}"] }, remote: {} }, "agmux");
  expect(attachCtxFor(s, { TMUX: "/tmp/x,1,0" }, true)).toEqual({ inMux: true, popup: true, terminalWindow: false, terminalTab: true });
  expect(attachCtxFor(s, {}, false).inMux).toBe(false);
});

test("a resumed agent's new session is named after its id", () => {
  expect(resumeSessionName(ID)).toBe("agmux-019f1898");
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

test("settings fill the [attach.remote] defaults", () => {
  expect(attachSettingsFrom({ terminal: {}, remote: {} }, "agmux").remote).toEqual({
    placement: "new-window", mode: "view", windowName: "⇄ {title}", detachKey: "M-d",
  });
  expect(attachSettingsFrom({ terminal: {}, remote: { mode: "full", detachKey: "C-q" } }, "agmux").remote)
    .toEqual({ placement: "new-window", mode: "full", windowName: "⇄ {title}", detachKey: "C-q" });
});

test("attachCtxFor sets inMux for tmux and for rex", () => {
  const s = attachSettingsFrom({ terminal: {}, remote: {} }, "agmux");
  expect(attachCtxFor(s, { TMUX: "/tmp/x,1,0" }, false).inMux).toBe(true);
  expect(attachCtxFor(s, { REX_BLOCK: "B1" }, false).inMux).toBe(true);
  expect(attachCtxFor(s, {}, false).inMux).toBe(false);
});

test("withoutTmuxEnv removes REX_BLOCK, REX_SESSION, REX_SERVER", async () => {
  const { withoutTmuxEnv } = await import("../src/attach-place.ts");
  expect(withoutTmuxEnv({ TMUX: "x", TMUX_PANE: "%1", REX_BLOCK: "b", REX_SESSION: "s", REX_SERVER: "v", PATH: "/bin" })).toEqual({ PATH: "/bin" });
});
