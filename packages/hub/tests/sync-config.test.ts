import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseRemotes, loadRemotes } from "../src/sync/config.ts";

describe("parseRemotes", () => {
  test("undefined → []", () => expect(parseRemotes(undefined)).toEqual([]));

  test("fills defaults", () => {
    expect(parseRemotes([{ name: "ai-sandbox", gateway: "ai-sandbox" }])).toEqual([
      { name: "ai-sandbox", transport: "openshell", gateway: "ai-sandbox", selector: "agmux=1",
        interval: 5, openshell_bin: "openshell", agmux_bin: "agmux", workdir: null, launch: null },
    ]);
  });

  test("keeps explicit values", () => {
    const [r] = parseRemotes([{ name: "a", gateway: "g", selector: "x=1", interval: 9, openshell_bin: "/o", agmux_bin: "/a" }]);
    expect(r).toMatchObject({ selector: "x=1", interval: 9, openshell_bin: "/o", agmux_bin: "/a" });
  });

  test("non-array throws", () => {
    expect(() => parseRemotes({ name: "a" })).toThrow("[[remote]] must be an array of tables");
    expect(() => parseRemotes(["x"])).toThrow("[[remote]] #0: must be a table");
  });

  test("errors", () => {
    expect(() => parseRemotes([{ name: "a", gateway: "g", transport: "ssh" }]))
      .toThrow('[[remote]] "a": transport "ssh" is not supported yet');
    expect(() => parseRemotes([{ name: "a", gateway: "g" }, { name: "a", gateway: "g" }]))
      .toThrow('[[remote]] "a": duplicate name');
    expect(() => parseRemotes([{ name: "a/b", gateway: "g" }])).toThrow('[[remote]] "a/b": invalid name');
    expect(() => parseRemotes([{ gateway: "g" }])).toThrow("[[remote]] #0: missing name");
    expect(() => parseRemotes([{ name: "a", gateway: "-g x" }])).toThrow('[[remote]] "a": invalid gateway');
    expect(() => parseRemotes([{ name: "a" }])).toThrow('[[remote]] "a": missing gateway');
    expect(() => parseRemotes([{ name: "a", gateway: "g", interval: 0 }])).toThrow('[[remote]] "a": interval must be a number >= 0.1');
    expect(() => parseRemotes([{ name: "a", gateway: "g", interval: 0.05 }])).toThrow('[[remote]] "a": interval must be a number >= 0.1');
    expect(parseRemotes([{ name: "a", gateway: "g", interval: 0.1 }])[0]!.interval).toBe(0.1);
    expect(() => parseRemotes([{ name: "a", gateway: "g", bogus: 1 }])).toThrow('[[remote]] "a": unknown key "bogus"');
  });
});

describe("parseRemotes launch", () => {
  const one = (extra: Record<string, unknown>) => parseRemotes([{ name: "ai-sandbox", gateway: "g", ...extra }])[0]!;
  const err = (extra: Record<string, unknown>) => () => one(extra);

  test("kind + args + workdir", () => {
    const r = one({ workdir: "/sandbox/work", kind: "claude", args: ["--dangerously-skip-permissions"] });
    expect(r.workdir).toBe("/sandbox/work");
    expect(r.launch).toEqual({ kind: "claude", profile: null, command: null, args: ["--dangerously-skip-permissions"] });
  });

  test("no launch keys → launch null (workdir alone does not make a launch)", () => {
    expect(one({}).launch).toBeNull();
    const r = one({ workdir: "/w" });
    expect(r.launch).toBeNull();
    expect(r.workdir).toBe("/w");
  });

  test("profile alone, kind alone, kind + command", () => {
    expect(one({ profile: "p" }).launch).toEqual({ kind: null, profile: "p", command: null, args: [] });
    expect(one({ kind: "pi" }).launch).toEqual({ kind: "pi", profile: null, command: null, args: [] });
    expect(one({ kind: "codex", command: "/bin/c" }).launch)
      .toEqual({ kind: "codex", profile: null, command: "/bin/c", args: [] });
  });

  test("rules", () => {
    expect(err({ profile: "p", command: "c" })).toThrow('[[remote]] "ai-sandbox": profile excludes command/args');
    expect(err({ profile: "p", args: ["a"] })).toThrow('[[remote]] "ai-sandbox": profile excludes command/args');
    expect(err({ command: "c" })).toThrow('[[remote]] "ai-sandbox": kind is required unless profile is set');
    expect(err({ args: ["a"] })).toThrow('[[remote]] "ai-sandbox": kind is required unless profile is set');
    expect(err({ kind: "gemini" })).toThrow('[[remote]] "ai-sandbox": kind must be one of claude, codex, pi');
    expect(err({ kind: "claude", args: "x" })).toThrow('[[remote]] "ai-sandbox": args must be an array of strings');
    expect(err({ kind: "claude", args: [1] })).toThrow("args must be an array of strings");
    expect(err({ workdir: "" })).toThrow('[[remote]] "ai-sandbox": workdir must be a non-empty string');
  });
});

describe("loadRemotes", () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "agmux-remote-"));

  test("missing file / section → []", () => {
    const d = tmp();
    expect(loadRemotes(path.join(d, "none.toml"))).toEqual([]);
    fs.writeFileSync(path.join(d, "c.toml"), "[ls]\nlimit = 3\n");
    expect(loadRemotes(path.join(d, "c.toml"))).toEqual([]);
  });

  test("parses [[remote]]", () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, "c.toml"), '[[remote]]\nname = "x"\ngateway = "g"\n');
    expect(loadRemotes(path.join(d, "c.toml")).map((r) => r.name)).toEqual(["x"]);
  });

  test("a TOML syntax error names the config file", () => {
    const d = tmp();
    const p = path.join(d, "c.toml");
    fs.writeFileSync(p, '[[remote]]\nname = "x\n');
    expect(() => loadRemotes(p)).toThrow(`${p}: `);
  });
});
