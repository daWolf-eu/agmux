import { test, expect } from "bun:test";
import { parseDashArgs } from "../src/parse-dash.ts";

test("defaults: events preview, 1s interval, open status, started sort", () => {
  const p = parseDashArgs([], {});
  expect(p.kind).toBe("ok");
  if (p.kind !== "ok") return;
  expect(p.opts.preview).toBe("events");
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
