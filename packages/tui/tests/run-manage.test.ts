import { test, expect } from "bun:test";
import { handoffArgv } from "../src/run-manage.tsx";

test("null handoff yields no spawn", () => {
  expect(handoffArgv(null)).toBeNull();
});

test("empty-argv handoff is the exit sentinel: no spawn", () => {
  expect(handoffArgv({ argv: [] })).toBeNull();
});

test("non-empty handoff yields its argv", () => {
  expect(handoffArgv({ argv: ["tmux", "switch-client"] })).toEqual(["tmux", "switch-client"]);
});
