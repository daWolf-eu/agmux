import { test, expect } from "bun:test";
import { parseLsArgs } from "../src/parse-ls.ts";

function ok(argv: string[], defaults = {}) {
  const r = parseLsArgs(argv, defaults);
  if (r.kind !== "ok") throw new Error(`expected ok, got: ${r.message}`);
  return r.opts;
}

test("built-in defaults with no flags and no config", () => {
  expect(ok([])).toEqual({
    limit: 50, sort: "started", asc: false, reverse: false,
    status: undefined, agent: undefined, profile: undefined,
  });
});

test("flags parse in space and = forms", () => {
  const o = ok(["-n", "5", "--sort=activity", "--asc", "-r", "--status", "active", "--agent=claude", "--profile", "work"]);
  expect(o).toEqual({
    limit: 5, sort: "activity", asc: true, reverse: true,
    status: "active", agent: "claude", profile: "work",
  });
});

test("config supplies defaults; flags win over config", () => {
  const defaults = { limit: 10, sort: "activity" as const, asc: true, reverse: true, status: "open" };
  expect(ok([], defaults)).toEqual({
    limit: 10, sort: "activity", asc: true, reverse: true,
    status: "open", agent: undefined, profile: undefined,
  });
  const o = ok(["-n", "3", "--sort", "started", "--desc", "--no-reverse", "--status", "closed"], defaults);
  expect(o).toEqual({
    limit: 3, sort: "started", asc: false, reverse: false,
    status: "closed", agent: undefined, profile: undefined,
  });
});

test("--all means uncapped; explicit -n wins over --all and over config", () => {
  expect(ok(["--all"]).limit).toBe(10000);
  expect(ok(["--all", "-n", "5"]).limit).toBe(5);
  expect(ok(["--all"], { limit: 10 }).limit).toBe(10000); // flag beats config
});

test("--live is an alias for --status open; explicit --status wins", () => {
  expect(ok(["--live"]).status).toBe("open");
  expect(ok(["--live"], { status: "closed" }).status).toBe("open"); // flag beats config
  expect(ok(["--live", "--status", "closed"]).status).toBe("closed");
});

test("invalid values error", () => {
  expect(parseLsArgs(["--sort", "size"], {}).kind).toBe("error");
  expect(parseLsArgs(["-n", "zero"], {}).kind).toBe("error");
  expect(parseLsArgs(["-n", "0"], {}).kind).toBe("error");
  expect(parseLsArgs(["--status", "bogus"], {}).kind).toBe("error");
  expect(parseLsArgs(["--frobnicate"], {}).kind).toBe("error");
});

test("boolean flags reject an attached =value", () => {
  expect(parseLsArgs(["--asc=false"], {}).kind).toBe("error");
  expect(parseLsArgs(["-r=x"], {}).kind).toBe("error");
});

test("value flags error when value is missing", () => {
  expect(parseLsArgs(["--sort"], {}).kind).toBe("error");
  expect(parseLsArgs(["--limit"], {}).kind).toBe("error");
  expect(parseLsArgs(["--agent"], {}).kind).toBe("error");
});
