import { test, expect } from "bun:test";
import { createDefaultRegistry } from "../src/index.ts";

test("the default registry has the claude adapter wired in", () => {
  const r = createDefaultRegistry();
  expect(r.kinds()).toContain("claude");
  expect(r.lookup("claude")!.agentKind).toBe("claude");
});
