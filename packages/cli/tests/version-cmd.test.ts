import { test, expect } from "bun:test";
import { AGMUX_VERSION } from "@agmux/protocol";
import { createRegistry } from "@agmux/adapters";
import { fakeAdapter } from "@agmux/adapters/testing";
import { formatVersion } from "../src/version-cmd.ts";

test("formatVersion reports the agmux version and each registered adapter's version", () => {
  const reg = createRegistry();
  reg.register(fakeAdapter); // agentKind "claude", adapterVersion "1"
  const out = formatVersion(reg);
  expect(out).toContain(`agmux ${AGMUX_VERSION}`);
  expect(out).toContain("claude v1");
});

test("formatVersion still prints the agmux line with no adapters registered", () => {
  const reg = createRegistry();
  const out = formatVersion(reg);
  expect(out).toContain(`agmux ${AGMUX_VERSION}`);
  expect(out).toContain("(none)");
});
