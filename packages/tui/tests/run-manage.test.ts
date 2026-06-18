import { test, expect } from "bun:test";
import { resolveHandoff } from "../src/run-manage.tsx";

test("null handoff yields no spawn", () => {
  expect(resolveHandoff(null)).toBeNull();
});

test("empty-argv handoff is the exit sentinel: no spawn", () => {
  expect(resolveHandoff({ argv: [] })).toBeNull();
});

test("non-empty handoff is returned as-is", () => {
  const h = { argv: ["tmux", "switch-client"] };
  expect(resolveHandoff(h)).toEqual(h);
});
