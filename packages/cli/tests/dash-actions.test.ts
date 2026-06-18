import { test, expect } from "bun:test";
import { attachInPopup, resumeIntoNewWindow } from "../src/dash-actions.ts";

test("attachInPopup issues switch-client (+ select-pane) then returns the exit sentinel", async () => {
  const calls: string[][] = [];
  const runTmux = async (args: string[]) => { calls.push(args); };
  const h = await attachInPopup(
    { tmux_session: "work", tmux_window: "@3", tmux_pane: "%5" },
    runTmux,
  );
  expect(calls).toEqual([
    ["switch-client", "-t", "work:@3"],
    ["select-pane", "-t", "%5"],
  ]);
  expect(h).toEqual({ argv: [] });
});

test("attachInPopup without a pane switches window only", async () => {
  const calls: string[][] = [];
  const runTmux = async (args: string[]) => { calls.push(args); };
  await attachInPopup({ tmux_session: "work", tmux_window: "@3", tmux_pane: null }, runTmux);
  expect(calls).toEqual([["switch-client", "-t", "work:@3"]]);
});

test("resumeIntoNewWindow forwards the agmux env allowlist (incl. hub url), drops the rest, returns the exit sentinel", async () => {
  let seen: any = null;
  const fakeNewWindow = async (a: any) => { seen = a; return { session: a.sessionName, window: "@9", pane: "%9" }; };
  const spec = {
    wrapArgv: ["agmux-wrap", "claude"],
    env: { PATH: "/bin", AGMUX_HUB_URL: "http://h", AGMUX_SESSION_ID: "abc12345" },
  };
  const h = await resumeIntoNewWindow(spec, "work", "abc12345", fakeNewWindow);
  expect(seen.sessionName).toBe("work");
  expect(seen.windowName).toBe("agmux:abc12345");
  expect(seen.cmd).toEqual(["agmux-wrap", "claude"]);
  expect(seen.env).toEqual({ AGMUX_HUB_URL: "http://h", AGMUX_SESSION_ID: "abc12345" });
  expect(seen.detach).toBe(false);
  expect(h).toEqual({ argv: [] });
});
