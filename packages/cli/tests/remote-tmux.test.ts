import { test, expect } from "bun:test";
import {
  viewSessionName, viewScriptArgv, fullScriptArgv, reapScriptArgv,
  REAP_FN, VIEW_SCRIPT, FULL_SCRIPT, REAP_SCRIPT,
} from "../src/remote-tmux.ts";

const ID = "019f1898-8e0f-7000-ab55-07d09f673b59";

test("view session name is agmux-view-<id8>-<tag>", () => {
  expect(viewSessionName(ID, "p12")).toBe("agmux-view-019f1898-p12");
});

test("script texts are exported constants built on the shared reap function", () => {
  for (const s of [VIEW_SCRIPT, FULL_SCRIPT, REAP_SCRIPT]) {
    expect(typeof s).toBe("string");
    expect(s).toContain(REAP_FN);
  }
});

test("viewScriptArgv: $0 is agmux, null socket and pane become empty strings", () => {
  const argv = viewScriptArgv({ session: "work", window: "@0", pane: null, socket: null }, "agmux-view-019f1898-p1", "M-d", "p1");
  expect(argv).toEqual(["sh", "-c", VIEW_SCRIPT, "agmux", "", "@0", "", "agmux-view-019f1898-p1", "M-d", "p1"]);
});

test("viewScriptArgv passes socket and pane through", () => {
  const argv = viewScriptArgv({ session: "work", window: "@3", pane: "%7", socket: "/tmp/tmux-998/default" }, "V", "M-q", "t0a1b2c3d");
  expect(argv.slice(3)).toEqual(["agmux", "/tmp/tmux-998/default", "@3", "%7", "V", "M-q", "t0a1b2c3d"]);
});

test("fullScriptArgv: socket, session, window, pane, tag", () => {
  expect(fullScriptArgv({ session: "work", window: "@0", pane: "%0", socket: "/s" }, "p1"))
    .toEqual(["sh", "-c", FULL_SCRIPT, "agmux", "/s", "work", "@0", "%0", "p1"]);
  expect(fullScriptArgv({ session: "work", window: "@0", pane: null, socket: null }, "p1"))
    .toEqual(["sh", "-c", FULL_SCRIPT, "agmux", "", "work", "@0", "", "p1"]);
});

test("reapScriptArgv carries only the tag", () => {
  expect(reapScriptArgv("p1")).toEqual(["sh", "-c", REAP_SCRIPT, "agmux", "p1"]);
});
