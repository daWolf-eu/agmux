import { test, expect } from "bun:test";
import { createDefaultRegistry } from "../src/index.ts";

test("the default registry has the claude adapter wired in", () => {
  const r = createDefaultRegistry();
  expect(r.kinds()).toContain("claude");
  expect(r.lookup("claude")!.agentKind).toBe("claude");
});

test("the default registry has the codex adapter wired in", () => {
  const r = createDefaultRegistry();
  expect(r.kinds()).toContain("codex");
  expect(r.lookup("codex")!.agentKind).toBe("codex");
});

test("the default registry has the pi adapter wired in", () => {
  const r = createDefaultRegistry();
  expect(r.kinds()).toContain("pi");
  expect(r.lookup("pi")!.agentKind).toBe("pi");
});
