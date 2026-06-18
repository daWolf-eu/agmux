import { test, expect } from "bun:test";
import { dashCmd, type DashCmdDeps } from "../src/dash.ts";
import type { DashOpts } from "../src/parse-dash.ts";

const opts: DashOpts & { hubUrl: string; wrapBin: string } = {
  limit: 50, sort: "started", asc: false, reverse: false, status: "open",
  intervalMs: 1000, preview: "events", popup: false, hubUrl: "http://h", wrapBin: "agmux-wrap",
};

test("non-TTY returns 2 and prints a hint", async () => {
  let err = "";
  const deps: DashCmdDeps = {
    isTTY: () => false,
    runManageImpl: async () => 0,
    makeSourceImpl: () => ({ async mirror() { return ""; }, async events() { return []; }, async usage() { return null; } }),
    makeActionsImpl: () => ({ async attach() { return null; }, async kill() {}, async resume() { return { argv: [] }; } }),
    errOut: (s) => { err = s; },
  };
  expect(await dashCmd(opts, deps)).toBe(2);
  expect(err).toContain("requires a TTY");
});

test("TTY path forwards preview + interval to runManage", async () => {
  let seen: { defaultPreview?: string; intervalMs?: number } = {};
  const deps: DashCmdDeps = {
    isTTY: () => true,
    runManageImpl: async (o) => { seen = { defaultPreview: o.defaultPreview, intervalMs: o.intervalMs }; return 0; },
    makeSourceImpl: () => ({ async mirror() { return ""; }, async events() { return []; }, async usage() { return null; } }),
    makeActionsImpl: () => ({ async attach() { return null; }, async kill() {}, async resume() { return { argv: [] }; } }),
    errOut: () => {},
  };
  expect(await dashCmd(opts, deps)).toBe(0);
  expect(seen).toEqual({ defaultPreview: "events", intervalMs: 1000 });
});

test("forwards popup flag to makeActions", async () => {
  let seenPopup: boolean | undefined;
  const deps: DashCmdDeps = {
    isTTY: () => true,
    runManageImpl: async () => 0,
    makeSourceImpl: () => ({ async mirror() { return ""; }, async events() { return []; }, async usage() { return null; } }),
    makeActionsImpl: (_h, _w, popup) => { seenPopup = popup; return { async attach() { return null; }, async kill() {}, async resume() { return { argv: [] }; } }; },
    errOut: () => {},
  };
  expect(await dashCmd({ ...opts, popup: true }, deps)).toBe(0);
  expect(seenPopup).toBe(true);
});
