import { describe, expect, test } from "bun:test";
import { parseRemotes } from "../src/sync/config.ts";
import { openshellTransport } from "../src/sync/transport.ts";
import { openshellDiscovery, parseSandboxList, runCapture } from "../src/sync/discovery.ts";

const [remote] = parseRemotes([{ name: "r", gateway: "ai-sandbox", openshell_bin: "/bin/os" }]);

describe("openshellTransport", () => {
  const t = openshellTransport(remote!);
  test("argv no-tty", () => {
    expect(t.argv("wi-1", ["agmux", "x"], { tty: false })).toEqual(
      ["/bin/os", "-g", "ai-sandbox", "sandbox", "exec", "-n", "wi-1", "--no-tty", "--", "agmux", "x"]);
  });
  test("argv tty", () => {
    expect(t.argv("wi-1", ["sh"], { tty: true })).toEqual(
      ["/bin/os", "-g", "ai-sandbox", "sandbox", "exec", "-n", "wi-1", "--tty", "--", "sh"]);
  });
  test("spec", () => {
    expect(t.spec("wi-1")).toEqual({ kind: "openshell", gateway: "ai-sandbox", target: "wi-1", bin: "/bin/os" });
  });
});

const FIXTURE = JSON.stringify([{ name: "wi-sag-280", id: "770299bf26e0", phase: "Ready", labels: { agmux: "1" },
  annotations: {}, created_at: "2026-10-11T09:00:00Z", current_policy_version: 3, resource_version: "12", workspace: null }]);

describe("parseSandboxList", () => {
  test("spike shape", () => {
    expect(parseSandboxList(FIXTURE, "ai-sandbox")).toEqual([{ target: "wi-sag-280", host: "ai-sandbox/wi-sag-280" }]);
  });
  test("skips nameless and invalid names", () => {
    const j = JSON.stringify([{ id: "x" }, { name: 5 }, { name: "bad name" }, { name: "ok" }]);
    expect(parseSandboxList(j, "g")).toEqual([{ target: "ok", host: "g/ok" }]);
  });
  test("skips flag-like names", () => {
    expect(parseSandboxList(JSON.stringify([{ name: "-x" }, { name: "ok" }]), "g")).toEqual([{ target: "ok", host: "g/ok" }]);
  });
  test("invalid JSON throws", () => expect(() => parseSandboxList("nope", "g")).toThrow());
  test("non-array throws", () => expect(() => parseSandboxList("{}", "g")).toThrow());
});

describe("openshellDiscovery", () => {
  test("runs list argv", async () => {
    let seen: string[] = [];
    const d = openshellDiscovery(remote!, async (argv) => { seen = argv; return FIXTURE; });
    expect(await d.list()).toHaveLength(1);
    expect(seen).toEqual(["/bin/os", "-g", "ai-sandbox", "sandbox", "list", "-o", "json", "--selector", "agmux=1"]);
  });
});

describe("runCapture", () => {
  test("stdout", async () => expect(await runCapture(["echo", "hi"])).toBe("hi\n"));
  test("non-zero exit carries stderr", async () => {
    await expect(runCapture(["sh", "-c", "echo oops >&2; exit 3"])).rejects.toThrow("oops");
  });
  test("timeout kills and rejects", async () => {
    const t0 = Date.now();
    await expect(runCapture(["sleep", "5"], { timeoutMs: 100 })).rejects.toThrow("timed out after 100 ms");
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});
