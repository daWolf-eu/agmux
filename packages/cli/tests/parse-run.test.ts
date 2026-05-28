import { test, expect } from "bun:test";
import { parseRunArgs } from "../src/parse-run.ts";

test("profile mode: -p <name>", () => {
  expect(parseRunArgs(["-p", "claude-work"]))
    .toEqual({ kind: "profile", profileName: "claude-work" });
});

test("profile mode: --profile <name>", () => {
  expect(parseRunArgs(["--profile", "claude-work"]))
    .toEqual({ kind: "profile", profileName: "claude-work" });
});

test("profile mode rejects extra positional", () => {
  const r = parseRunArgs(["-p", "claude-work", "claude"]);
  expect(r.kind).toBe("error");
  if (r.kind === "error") expect(r.message).toMatch(/cannot combine/);
});

test("inline: basename 'claude' detects kind", () => {
  expect(parseRunArgs(["claude", "--resume", "abc"]))
    .toEqual({ kind: "inline", agent_kind: "claude", command: "claude", args: ["--resume", "abc"] });
});

test("inline: basename 'codex' detects kind", () => {
  expect(parseRunArgs(["codex"]))
    .toEqual({ kind: "inline", agent_kind: "codex", command: "codex", args: [] });
});

test("inline: absolute path basename detection", () => {
  expect(parseRunArgs(["/opt/bin/claude", "--foo"]))
    .toEqual({ kind: "inline", agent_kind: "claude", command: "/opt/bin/claude", args: ["--foo"] });
});

test("inline: --kind override", () => {
  expect(parseRunArgs(["--kind=codex", "/opt/agent-rc1", "--foo"]))
    .toEqual({ kind: "inline", agent_kind: "codex", command: "/opt/agent-rc1", args: ["--foo"] });
});

test("inline: --kind <v> form", () => {
  expect(parseRunArgs(["--kind", "claude", "myagent"]))
    .toEqual({ kind: "inline", agent_kind: "claude", command: "myagent", args: [] });
});

test("inline: -- separator forces command parsing", () => {
  expect(parseRunArgs(["--kind=claude", "--", "--weird-binary", "--foo"]))
    .toEqual({ kind: "inline", agent_kind: "claude", command: "--weird-binary", args: ["--foo"] });
});

test("error: unknown basename without --kind", () => {
  const r = parseRunArgs(["myagent", "--foo"]);
  expect(r.kind).toBe("error");
  if (r.kind === "error") expect(r.message).toMatch(/cannot infer agent_kind/);
});

test("error: bad --kind value", () => {
  const r = parseRunArgs(["--kind=bogus", "claude"]);
  expect(r.kind).toBe("error");
});

test("error: empty argv", () => {
  const r = parseRunArgs([]);
  expect(r.kind).toBe("error");
  if (r.kind === "error") expect(r.message).toMatch(/needs a command/);
});
