import { describe, expect, test } from "bun:test";
import { parseRemotes } from "../src/sync/config.ts";
import { openshellTransport } from "../src/sync/transport.ts";
import { MAX_LIST_PAGES, openshellDiscovery, parseSandboxList, runCapture } from "../src/sync/discovery.ts";

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

const PAGE = (sandboxes: unknown[], next = "") => JSON.stringify({ next_page_token: next, sandboxes });
const nodes = (json: string, gw = "g") => parseSandboxList(json, gw).nodes;

describe("parseSandboxList", () => {
  test("bare array (0.0.116 shape)", () => {
    expect(parseSandboxList(FIXTURE, "ai-sandbox")).toEqual(
      { nodes: [{ target: "wi-sag-280", host: "ai-sandbox/wi-sag-280" }], next: "" });
  });
  test("page object (0.1.5 shape)", () => {
    expect(parseSandboxList(PAGE([{ name: "wi-sag-280", phase: "Ready" }], "t1"), "ai-sag")).toEqual(
      { nodes: [{ target: "wi-sag-280", host: "ai-sag/wi-sag-280" }], next: "t1" });
  });
  test("non-string token reads as last page", () => {
    expect(parseSandboxList(JSON.stringify({ sandboxes: [], next_page_token: 7 }), "g").next).toBe("");
  });
  test("skips nameless and invalid names", () => {
    const j = JSON.stringify([{ id: "x" }, { name: 5 }, { name: "bad name" }, { name: "ok" }]);
    expect(nodes(j)).toEqual([{ target: "ok", host: "g/ok" }]);
  });
  test("skips flag-like names", () => {
    expect(nodes(JSON.stringify([{ name: "-x" }, { name: "ok" }]))).toEqual([{ target: "ok", host: "g/ok" }]);
  });
  test("invalid JSON throws", () => expect(() => nodes("nope")).toThrow());
  test("object without sandboxes throws", () => expect(() => nodes("{}")).toThrow());
  test("null throws", () => expect(() => nodes("null")).toThrow());
});

describe("openshellDiscovery", () => {
  const LIST = ["/bin/os", "-g", "ai-sandbox", "sandbox", "list", "-o", "json", "--selector", "agmux=1"];
  test("runs list argv", async () => {
    let seen: string[] = [];
    const d = openshellDiscovery(remote!, async (argv) => { seen = argv; return FIXTURE; });
    expect(await d.list()).toHaveLength(1);
    expect(seen).toEqual(LIST);
  });
  test("follows next_page_token", async () => {
    const seen: string[][] = [];
    const pages: Record<string, string> = { "": PAGE([{ name: "a" }], "t1"), t1: PAGE([{ name: "b" }]) };
    const d = openshellDiscovery(remote!, async (argv) => {
      seen.push(argv);
      const i = argv.indexOf("--page-token");
      return pages[i < 0 ? "" : argv[i + 1]!]!;
    });
    expect((await d.list()).map((n) => n.target)).toEqual(["a", "b"]);
    expect(seen).toEqual([LIST, [...LIST, "--page-token", "t1"]]);
  });
  test("repeated token stops", async () => {
    let calls = 0;
    const d = openshellDiscovery(remote!, async () => { calls++; return PAGE([{ name: "a" }], "same"); });
    expect(await d.list()).toHaveLength(2);
    expect(calls).toBe(2);
  });
  test("endless distinct tokens throw", async () => {
    let calls = 0;
    const d = openshellDiscovery(remote!, async () => PAGE([], `t${++calls}`));
    await expect(d.list()).rejects.toThrow("more than");
    expect(calls).toBe(MAX_LIST_PAGES);
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
