import { test, expect } from "bun:test";
import {
  attachKind, attachTargets, defaultPlacement, resolvePlacement, NO_ATTACH_CTX, type AttachCtx,
} from "../../src/shared/attach-targets.ts";
import { mkRow } from "../helpers/mk-row.ts";

const TMUX: AttachCtx = { inTmux: true, popup: false, terminalWindow: false, terminalTab: false };
const POPUP: AttachCtx = { ...TMUX, popup: true };
const reasons = (ts: ReturnType<typeof attachTargets>) => Object.fromEntries(ts.map((t) => [t.placement, t.reason]));

test("attachKind: closed by status, live needs tmux coords, otherwise none", () => {
  expect(attachKind(mkRow({ status: "lost" }))).toBe("closed");
  expect(attachKind(mkRow({ status: "ended" }))).toBe("closed");
  expect(attachKind(mkRow({ status: "running", tmux_session: "s", tmux_window: "@1" }))).toBe("live");
  expect(attachKind(mkRow({ status: "running" }))).toBe("none");
});

test("seven targets in slot order with labels", () => {
  expect(attachTargets("live", TMUX).map((t) => t.label)).toEqual([
    "inline", "new pane", "new window", "new session", "peek", "new tab", "new terminal window",
  ]);
});

test("live in tmux: tmux placements on, peek planned, terminals unconfigured", () => {
  expect(reasons(attachTargets("live", TMUX))).toEqual({
    inline: "", "new-pane": "", "new-window": "", "new-session": "",
    peek: "planned", "new-tab": "not configured", "new-terminal": "not configured",
  });
});

test("outside tmux only inline and configured terminals are enabled", () => {
  const ctx = { ...NO_ATTACH_CTX, terminalWindow: true };
  const on = attachTargets("live", ctx).filter((t) => t.enabled).map((t) => t.placement);
  expect(on).toEqual(["inline", "new-terminal"]);
  expect(reasons(attachTargets("live", ctx))["new-pane"]).toBe("not in tmux");
});

test("closed in a popup: inline disabled, peek ends with popup", () => {
  const r = reasons(attachTargets("closed", POPUP));
  expect(r.inline).toBe("in popup");
  expect(r.peek).toBe("ends with popup");
  expect(r["new-window"]).toBe("");
});

test("no tmux pane: everything disabled", () => {
  expect(attachTargets("none", TMUX).every((t) => !t.enabled && t.reason === "no tmux pane")).toBe(true);
});

test("defaults without config keep today's ⏎ behaviour", () => {
  expect(defaultPlacement("live", TMUX)).toBe("inline");
  expect(defaultPlacement("closed", TMUX)).toBe("new-window");
  expect(defaultPlacement("closed", NO_ATTACH_CTX)).toBe("inline");
  expect(defaultPlacement("closed", POPUP)).toBe("new-window");
});

test("configured defaults apply when available", () => {
  expect(defaultPlacement("live", TMUX, { live: "new-session" })).toBe("new-session");
  expect(defaultPlacement("closed", TMUX, { closed: "new-pane" })).toBe("new-pane");
});

test("a configured default impossible in context falls back to inline", () => {
  expect(defaultPlacement("live", NO_ATTACH_CTX, { live: "new-window" })).toBe("inline");
  expect(defaultPlacement("live", TMUX, { live: "peek" })).toBe("inline");
});

test("a closed default of inline in a popup falls back to new-window", () => {
  expect(defaultPlacement("closed", POPUP, { closed: "inline" })).toBe("new-window");
});

test("resolvePlacement passes enabled requests, rejects disabled ones, defaults when absent", () => {
  expect(resolvePlacement("live", TMUX, "new-pane")).toBe("new-pane");
  expect(() => resolvePlacement("live", NO_ATTACH_CTX, "new-pane")).toThrow("new pane: not in tmux");
  expect(resolvePlacement("closed", TMUX, undefined)).toBe("new-window");
});
