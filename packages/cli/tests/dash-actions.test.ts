import { test, expect } from "bun:test";
import { deltaEnv, attachInPopup } from "../src/dash-actions.ts";

test("deltaEnv returns only keys whose value differs from base", () => {
  const base = { PATH: "/bin", HOME: "/home/x" };
  const spec = { PATH: "/bin", HOME: "/home/x", AGMUX_SESSION_ID: "abc", AGMUX_HUB_URL: "http://h" };
  expect(deltaEnv(spec, base)).toEqual({ AGMUX_SESSION_ID: "abc", AGMUX_HUB_URL: "http://h" });
});

test("deltaEnv includes keys missing from base", () => {
  expect(deltaEnv({ A: "1" }, {})).toEqual({ A: "1" });
});

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
