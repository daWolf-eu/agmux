import { test, expect } from "bun:test";
import {
  attachSettingsFrom, attachCtxFor, resumeSessionName, shellQuote, expandTemplate,
} from "../src/attach-place.ts";

const ID = "019f1898-8e0f-7000-ab55-07d09f673b59";

test("settings take config values and fill defaults", () => {
  const s = attachSettingsFrom({ live: "new-window", terminal: { newWindow: ["x", "{cmd}"] } }, "/bin/agmux");
  expect(s).toEqual({ defaults: { live: "new-window", closed: undefined }, terminal: { newWindow: ["x", "{cmd}"] }, agmuxBin: "/bin/agmux" });
});

test("attachCtxFor reads TMUX and the configured terminals", () => {
  const s = attachSettingsFrom({ terminal: { newTab: ["t", "{cmd}"] } }, "agmux");
  expect(attachCtxFor(s, { TMUX: "/tmp/x,1,0" }, true)).toEqual({ inTmux: true, popup: true, terminalWindow: false, terminalTab: true });
  expect(attachCtxFor(s, {}, false).inTmux).toBe(false);
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
