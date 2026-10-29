import { expect, test } from "bun:test";
import type { TransportSpec } from "@agmux/protocol";
import { openshellControl } from "../src/sync/sandbox-control.ts";

const spec: TransportSpec = { kind: "openshell", gateway: "gw", target: "sbx", bin: "openshell" };

function fake(impl: (argv: string[]) => Promise<string>) {
  const calls: { argv: string[]; timeoutMs?: number }[] = [];
  const capture = (argv: string[], o: { timeoutMs?: number } = {}) => { calls.push({ argv, ...o }); return impl(argv); };
  return { calls, control: openshellControl(capture) };
}

test("status maps phase: Stopped -> stopped, anything else -> ready", async () => {
  const f = fake(async () => JSON.stringify({ phase: "Stopped" }));
  expect(await f.control.status(spec)).toEqual({ state: "stopped" });
  expect(f.calls[0]!.argv).toEqual(["openshell", "-g", "gw", "sandbox", "get", "sbx", "-o", "json"]);
  expect(await fake(async () => JSON.stringify({ phase: "Ready" })).control.status(spec)).toEqual({ state: "ready" });
  expect(await fake(async () => "{}").control.status(spec)).toEqual({ state: "ready" });
});

test("unparseable output from a successful get is ready", async () => {
  expect(await fake(async () => "not json").control.status(spec)).toEqual({ state: "ready" });
});

test("a failing get is missing with stderr's first non-empty line, sanitized", async () => {
  const f = fake(async () => { throw new Error("openshell exited 1: \n  sandbox\x1b[2Jnot found\nsecond line"); });
  const r = await f.control.status(spec);
  expect(r.state).toBe("missing");
  expect(r.state === "missing" && r.detail).toMatch(/^sandbox.*not found$/);
  expect(r.state === "missing" && r.detail).not.toContain("\x1b");
  expect(r.state === "missing" && r.detail).not.toContain("second");
});

test("a thrown non-exit error is missing with its message; long text is capped", async () => {
  expect(await fake(async () => { throw new Error("spawn ENOENT"); }).control.status(spec))
    .toEqual({ state: "missing", detail: "spawn ENOENT" });
  const r = await fake(async () => { throw new Error(`openshell exited 1: ${"x".repeat(500)}`); }).control.status(spec);
  expect(r.state === "missing" && r.detail.length).toBeLessThanOrEqual(301);
});

test("start runs `sandbox start <target>` and propagates failure", async () => {
  const f = fake(async () => "");
  await f.control.start(spec);
  expect(f.calls[0]!.argv).toEqual(["openshell", "-g", "gw", "sandbox", "start", "sbx"]);
  await expect(fake(async () => { throw new Error("boom"); }).control.start(spec)).rejects.toThrow("boom");
});
