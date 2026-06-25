import { test, expect } from "bun:test";
import { attachInPopup, resumeIntoSession, type ResumePlacementDeps } from "../src/dash-actions.ts";

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

function placementSpy(exists: boolean) {
  const calls: { newWindow: any[]; newSession: any[]; switched: string[] } = { newWindow: [], newSession: [], switched: [] };
  const deps: ResumePlacementDeps = {
    hasSession: async () => exists,
    newWindow: async (a: any) => { calls.newWindow.push(a); return { session: a.sessionName, window: "@7", pane: "%7" }; },
    newSession: async (a: any) => { calls.newSession.push(a); return { session: a.sessionName, window: "@1", pane: "%1" }; },
    switchClient: async (t: string) => { calls.switched.push(t); },
  };
  return { calls, deps };
}

const spec = {
  wrapArgv: ["agmux-wrap", "claude"],
  env: { PATH: "/bin", AGMUX_HUB_URL: "http://h", AGMUX_SESSION_ID: "abc12345" },
};

test("resumeIntoSession opens a new window in an existing session and switches the client", async () => {
  const { calls, deps } = placementSpy(true);
  const h = await resumeIntoSession(spec, "work", "abc12345", deps);
  expect(calls.newWindow).toHaveLength(1);
  expect(calls.newSession).toHaveLength(0);
  expect(calls.newWindow[0].sessionName).toBe("work");
  expect(calls.newWindow[0].windowName).toBe("agmux:abc12345");
  expect(calls.newWindow[0].cmd).toEqual(["agmux-wrap", "claude"]);
  // only the agmux env allowlist is forwarded (hub url + session id), PATH dropped
  expect(calls.newWindow[0].env).toEqual({ AGMUX_HUB_URL: "http://h", AGMUX_SESSION_ID: "abc12345" });
  expect(calls.newWindow[0].detach).toBe(true);
  expect(calls.switched).toEqual(["work:@7"]);
  expect(h).toEqual({ argv: [] });
});

test("resumeIntoSession creates the session when missing, then switches", async () => {
  const { calls, deps } = placementSpy(false);
  const h = await resumeIntoSession(spec, "gone", "abc12345", deps);
  expect(calls.newSession).toHaveLength(1);
  expect(calls.newWindow).toHaveLength(0);
  expect(calls.newSession[0].sessionName).toBe("gone");
  expect(calls.newSession[0].windowName).toBe("agmux:abc12345");
  expect(calls.switched).toEqual(["gone:@1"]);
  expect(h).toEqual({ argv: [] });
});
