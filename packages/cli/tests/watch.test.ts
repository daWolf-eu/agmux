import { test, expect } from "bun:test";
import { watchCmd } from "../src/watch.ts";

const opts = {
  limit: 50, sort: "started" as const, asc: false, reverse: false,
  status: "open", intervalMs: 1000, hubUrl: "http://127.0.0.1:9999",
};

test("non-TTY exits 2 without invoking the UI", async () => {
  const errs: string[] = [];
  let ran = false;
  const code = await watchCmd(opts, {
    isTTY: () => false,
    runWatchImpl: async () => { ran = true; return 0; },
    errOut: (s) => errs.push(s),
  });
  expect(code).toBe(2);
  expect(ran).toBe(false);
  expect(errs[0]).toContain("requires a TTY");
});

test("TTY delegates to runWatch with the built query", async () => {
  let got: { query: URLSearchParams; intervalMs: number } | null = null;
  const code = await watchCmd(opts, {
    isTTY: () => true,
    runWatchImpl: async (o) => { got = { query: o.query, intervalMs: o.intervalMs }; return 0; },
    errOut: () => {},
  });
  expect(code).toBe(0);
  expect(got!.query.get("status")).toBe("open");
  expect(got!.query.get("sort")).toBe("started");
  expect(got!.intervalMs).toBe(1000);
});
