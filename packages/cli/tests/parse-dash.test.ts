import { test, expect } from "bun:test";
import { parseDashArgs } from "../src/parse-dash.ts";

test("defaults: mirror preview, 1s interval, open status, started sort", () => {
  const p = parseDashArgs([], {});
  expect(p.kind).toBe("ok");
  if (p.kind !== "ok") return;
  expect(p.opts.preview).toBe("mirror");
  expect(p.opts.intervalMs).toBe(1000);
  expect(p.opts.status).toBe("open");
  expect(p.opts.sort).toBe("started");
});

test("config supplies preview/interval/status/sort defaults", () => {
  const p = parseDashArgs([], { preview: "detail", interval: 2, status: "active", sort: "activity" });
  expect(p.kind).toBe("ok");
  if (p.kind !== "ok") return;
  expect(p.opts.preview).toBe("detail");
  expect(p.opts.intervalMs).toBe(2000);
  expect(p.opts.status).toBe("active");
  expect(p.opts.sort).toBe("activity");
});

test("--preview flag overrides config", () => {
  const p = parseDashArgs(["--preview", "mirror"], { preview: "detail" });
  expect(p.kind === "ok" && p.opts.preview).toBe("mirror");
});

test("--preview rejects bad values", () => {
  const p = parseDashArgs(["--preview", "nope"], {});
  expect(p.kind).toBe("error");
});

test("-i overrides interval; ls flags still parse", () => {
  const p = parseDashArgs(["-i", "3", "--agent", "claude"], {});
  expect(p.kind).toBe("ok");
  if (p.kind !== "ok") return;
  expect(p.opts.intervalMs).toBe(3000);
  expect(p.opts.agent).toBe("claude");
});

test("--popup sets popup true and is not treated as an ls flag", () => {
  const p = parseDashArgs(["--popup", "--agent", "claude"], {});
  expect(p.kind).toBe("ok");
  if (p.kind !== "ok") return;
  expect(p.opts.popup).toBe(true);
  expect(p.opts.agent).toBe("claude");
});

test("popup defaults to false", () => {
  const p = parseDashArgs([], {});
  expect(p.kind === "ok" && p.opts.popup).toBe(false);
});

test("built-in group defaults: open small+fast, closed/all wide+slow", () => {
  const p = parseDashArgs([], {});
  expect(p.kind === "ok" && p.opts.groups).toEqual({
    open: { limit: 50, intervalMs: 1000 },
    closed: { limit: 1000, intervalMs: 10_000 },
    all: { limit: 1000, intervalMs: 10_000 },
  });
});

test("[dash] limit/interval seed every group; [dash.<group>] wins over them", () => {
  const p = parseDashArgs([], {
    limit: 25, interval: 2,
    groups: { closed: { limit: 5000, interval: 30 } },
  });
  expect(p.kind === "ok" && p.opts.groups).toEqual({
    open: { limit: 25, intervalMs: 2000 },
    closed: { limit: 5000, intervalMs: 30_000 },
    all: { limit: 25, intervalMs: 2000 },
  });
});

test("explicit -n/-i override every group, config included", () => {
  const p = parseDashArgs(["-n", "7", "-i", "4"], {
    limit: 25, groups: { closed: { limit: 5000, interval: 30 } },
  });
  expect(p.kind === "ok" && p.opts.groups).toEqual({
    open: { limit: 7, intervalMs: 4000 },
    closed: { limit: 7, intervalMs: 4000 },
    all: { limit: 7, intervalMs: 4000 },
  });
});

test("--all raises every group's limit", () => {
  const p = parseDashArgs(["--all"], {});
  expect(p.kind === "ok" && p.opts.groups.closed.limit).toBe(10_000);
  expect(p.kind === "ok" && p.opts.groups.open.limit).toBe(10_000);
});

test("a defaulted limit does not count as explicit", () => {
  // 50 happens to equal the built-in `open` default; the closed group must keep
  // its own wide default rather than inheriting it.
  const p = parseDashArgs([], {});
  expect(p.kind === "ok" && p.opts.groups.closed.limit).toBe(1000);
});
