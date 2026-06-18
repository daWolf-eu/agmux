import { test, expect } from "bun:test";
import { parseRunArgs } from "../src/parse-run.ts";

test("profile mode: -p <name>", () => {
  expect(parseRunArgs(["-p", "claude-work"]))
    .toEqual({ kind: "profile", profileName: "claude-work", placement: "inherit", detach: false, wrapped: false });
});

test("profile mode: --profile <name>", () => {
  expect(parseRunArgs(["--profile", "claude-work"]))
    .toEqual({ kind: "profile", profileName: "claude-work", placement: "inherit", detach: false, wrapped: false });
});

test("profile mode rejects extra positional", () => {
  const r = parseRunArgs(["-p", "claude-work", "claude"]);
  expect(r.kind).toBe("error");
  if (r.kind === "error") expect(r.message).toMatch(/cannot combine/);
});

test("inline: basename 'claude' detects kind", () => {
  expect(parseRunArgs(["claude", "--resume", "abc"]))
    .toEqual({ kind: "inline", agent_kind: "claude", command: "claude", args: ["--resume", "abc"], placement: "inherit", detach: false, wrapped: false });
});

test("inline: basename 'codex' detects kind", () => {
  expect(parseRunArgs(["codex"]))
    .toEqual({ kind: "inline", agent_kind: "codex", command: "codex", args: [], placement: "inherit", detach: false, wrapped: false });
});

test("inline: basename 'pi' detects kind", () => {
  expect(parseRunArgs(["pi", "--session", "abc"]))
    .toEqual({ kind: "inline", agent_kind: "pi", command: "pi", args: ["--session", "abc"], placement: "inherit", detach: false, wrapped: false });
});

test("inline: --kind=pi override", () => {
  expect(parseRunArgs(["--kind=pi", "/opt/pi-rc1"]))
    .toEqual({ kind: "inline", agent_kind: "pi", command: "/opt/pi-rc1", args: [], placement: "inherit", detach: false, wrapped: false });
});

test("inline: absolute path basename detection", () => {
  expect(parseRunArgs(["/opt/bin/claude", "--foo"]))
    .toEqual({ kind: "inline", agent_kind: "claude", command: "/opt/bin/claude", args: ["--foo"], placement: "inherit", detach: false, wrapped: false });
});

test("inline: --kind override", () => {
  expect(parseRunArgs(["--kind=codex", "/opt/agent-rc1", "--foo"]))
    .toEqual({ kind: "inline", agent_kind: "codex", command: "/opt/agent-rc1", args: ["--foo"], placement: "inherit", detach: false, wrapped: false });
});

test("inline: --kind <v> form", () => {
  expect(parseRunArgs(["--kind", "claude", "myagent"]))
    .toEqual({ kind: "inline", agent_kind: "claude", command: "myagent", args: [], placement: "inherit", detach: false, wrapped: false });
});

test("inline: -- separator forces command parsing", () => {
  expect(parseRunArgs(["--kind=claude", "--", "--weird-binary", "--foo"]))
    .toEqual({ kind: "inline", agent_kind: "claude", command: "--weird-binary", args: ["--foo"], placement: "inherit", detach: false, wrapped: false });
});

test("placement: -d defaults to --new-pane and sets detach", () => {
  expect(parseRunArgs(["-d", "-p", "claude-work"]))
    .toEqual({ kind: "profile", profileName: "claude-work", placement: "new-pane", detach: true, wrapped: false });
});

test("placement: --detach defaults to --new-pane (inline)", () => {
  expect(parseRunArgs(["--detach", "claude"]))
    .toEqual({ kind: "inline", agent_kind: "claude", command: "claude", args: [], placement: "new-pane", detach: true, wrapped: false });
});

test("placement: --new-window without -d sets placement only (detach=false)", () => {
  expect(parseRunArgs(["--new-window", "-p", "claude-work"]))
    .toEqual({ kind: "profile", profileName: "claude-work", placement: "new-window", detach: false, wrapped: false });
});

test("placement: --new-session on inline (detach=false)", () => {
  expect(parseRunArgs(["--new-session", "codex"]))
    .toEqual({ kind: "inline", agent_kind: "codex", command: "codex", args: [], placement: "new-session", detach: false, wrapped: false });
});

test("placement: -d then --new-window keeps detach=true with placement=new-window", () => {
  expect(parseRunArgs(["-d", "--new-window", "-p", "claude-work"]))
    .toEqual({ kind: "profile", profileName: "claude-work", placement: "new-window", detach: true, wrapped: false });
});

test("placement: conflicting --new-* flags is an error", () => {
  const r = parseRunArgs(["--new-pane", "--new-window", "claude"]);
  expect(r.kind).toBe("error");
  if (r.kind === "error") expect(r.message).toMatch(/cannot combine/);
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

test("inline run defaults wrapped:false", () => {
  const r = parseRunArgs(["claude"]);
  expect(r).toMatchObject({ kind: "inline", agent_kind: "claude", wrapped: false });
});

test("--wrapped sets wrapped:true (inline)", () => {
  const r = parseRunArgs(["--wrapped", "claude"]);
  expect(r).toMatchObject({ kind: "inline", wrapped: true });
});

test("--wrapped sets wrapped:true (profile)", () => {
  const r = parseRunArgs(["--wrapped", "-p", "work"]);
  expect(r).toMatchObject({ kind: "profile", profileName: "work", wrapped: true });
});

test("--wrapped composes with placement", () => {
  const r = parseRunArgs(["--new-window", "--wrapped", "claude"]);
  expect(r).toMatchObject({ kind: "inline", placement: "new-window", wrapped: true });
});
