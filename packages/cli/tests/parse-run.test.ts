import { test, expect } from "bun:test";
import { parseRunArgs } from "../src/parse-run.ts";

test("profile mode: -p <name>", () => {
  expect(parseRunArgs(["-p", "claude-work"]))
    .toEqual({ kind: "profile", profileName: "claude-work", placement: "inherit", detach: false, wrapped: false, direct: false, printCoords: false });
});

test("profile mode: --profile <name>", () => {
  expect(parseRunArgs(["--profile", "claude-work"]))
    .toEqual({ kind: "profile", profileName: "claude-work", placement: "inherit", detach: false, wrapped: false, direct: false, printCoords: false });
});

test("profile mode rejects extra positional", () => {
  const r = parseRunArgs(["-p", "claude-work", "claude"]);
  expect(r.kind).toBe("error");
  if (r.kind === "error") expect(r.message).toMatch(/cannot combine/);
});

test("inline: basename 'claude' detects kind", () => {
  expect(parseRunArgs(["claude", "--resume", "abc"]))
    .toEqual({ kind: "inline", agent_kind: "claude", command: "claude", args: ["--resume", "abc"], placement: "inherit", detach: false, wrapped: false, direct: false, printCoords: false });
});

test("inline: basename 'codex' detects kind", () => {
  expect(parseRunArgs(["codex"]))
    .toEqual({ kind: "inline", agent_kind: "codex", command: "codex", args: [], placement: "inherit", detach: false, wrapped: false, direct: false, printCoords: false });
});

test("inline: basename 'pi' detects kind", () => {
  expect(parseRunArgs(["pi", "--session", "abc"]))
    .toEqual({ kind: "inline", agent_kind: "pi", command: "pi", args: ["--session", "abc"], placement: "inherit", detach: false, wrapped: false, direct: false, printCoords: false });
});

test("inline: --kind=pi override", () => {
  expect(parseRunArgs(["--kind=pi", "/opt/pi-rc1"]))
    .toEqual({ kind: "inline", agent_kind: "pi", command: "/opt/pi-rc1", args: [], placement: "inherit", detach: false, wrapped: false, direct: false, printCoords: false });
});

test("inline: absolute path basename detection", () => {
  expect(parseRunArgs(["/opt/bin/claude", "--foo"]))
    .toEqual({ kind: "inline", agent_kind: "claude", command: "/opt/bin/claude", args: ["--foo"], placement: "inherit", detach: false, wrapped: false, direct: false, printCoords: false });
});

test("inline: --kind override", () => {
  expect(parseRunArgs(["--kind=codex", "/opt/agent-rc1", "--foo"]))
    .toEqual({ kind: "inline", agent_kind: "codex", command: "/opt/agent-rc1", args: ["--foo"], placement: "inherit", detach: false, wrapped: false, direct: false, printCoords: false });
});

test("inline: --kind <v> form", () => {
  expect(parseRunArgs(["--kind", "claude", "myagent"]))
    .toEqual({ kind: "inline", agent_kind: "claude", command: "myagent", args: [], placement: "inherit", detach: false, wrapped: false, direct: false, printCoords: false });
});

test("inline: -- separator forces command parsing", () => {
  expect(parseRunArgs(["--kind=claude", "--", "--weird-binary", "--foo"]))
    .toEqual({ kind: "inline", agent_kind: "claude", command: "--weird-binary", args: ["--foo"], placement: "inherit", detach: false, wrapped: false, direct: false, printCoords: false });
});

test("placement: -d defaults to --new-pane and sets detach", () => {
  expect(parseRunArgs(["-d", "-p", "claude-work"]))
    .toEqual({ kind: "profile", profileName: "claude-work", placement: "new-pane", detach: true, wrapped: false, direct: false, printCoords: false });
});

test("placement: --detach defaults to --new-pane (inline)", () => {
  expect(parseRunArgs(["--detach", "claude"]))
    .toEqual({ kind: "inline", agent_kind: "claude", command: "claude", args: [], placement: "new-pane", detach: true, wrapped: false, direct: false, printCoords: false });
});

test("placement: --new-window without -d sets placement only (detach=false)", () => {
  expect(parseRunArgs(["--new-window", "-p", "claude-work"]))
    .toEqual({ kind: "profile", profileName: "claude-work", placement: "new-window", detach: false, wrapped: false, direct: false, printCoords: false });
});

test("placement: --new-session on inline (detach=false)", () => {
  expect(parseRunArgs(["--new-session", "codex"]))
    .toEqual({ kind: "inline", agent_kind: "codex", command: "codex", args: [], placement: "new-session", detach: false, wrapped: false, direct: false, printCoords: false });
});

test("placement: -d then --new-window keeps detach=true with placement=new-window", () => {
  expect(parseRunArgs(["-d", "--new-window", "-p", "claude-work"]))
    .toEqual({ kind: "profile", profileName: "claude-work", placement: "new-window", detach: true, wrapped: false, direct: false, printCoords: false });
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
  expect(r).toMatchObject({ kind: "inline", agent_kind: "claude", wrapped: false, direct: false, printCoords: false });
});

test("--wrapped sets wrapped:true (inline)", () => {
  const r = parseRunArgs(["--wrapped", "claude"]);
  expect(r).toMatchObject({ kind: "inline", wrapped: true, direct: false, printCoords: false });
});

test("--wrapped sets wrapped:true (profile)", () => {
  const r = parseRunArgs(["--wrapped", "-p", "work"]);
  expect(r).toMatchObject({ kind: "profile", profileName: "work", wrapped: true, direct: false, printCoords: false });
});

test("--wrapped composes with placement", () => {
  const r = parseRunArgs(["--new-window", "--wrapped", "claude"]);
  expect(r).toMatchObject({ kind: "inline", placement: "new-window", wrapped: true, direct: false, printCoords: false });
});

test("--prompt requires a placement (inherit is rejected)", () => {
  const r = parseRunArgs(["--prompt", "do X", "-p", "work"]);
  expect(r.kind).toBe("error");
  if (r.kind === "error") expect(r.message).toMatch(/--prompt requires --headless, --new-pane/);
});

test("--prompt with --new-window carries the prompt text", () => {
  const r = parseRunArgs(["--new-window", "--prompt", "do X", "-p", "work"]);
  expect(r).toMatchObject({ kind: "profile", profileName: "work", placement: "new-window", prompt: "do X" });
});

test("--prompt composes with -d (inline)", () => {
  const r = parseRunArgs(["-d", "--prompt", "hello", "claude"]);
  expect(r).toMatchObject({ kind: "inline", agent_kind: "claude", placement: "new-pane", prompt: "hello" });
});

test("--prompt-file stores the path, not the contents", () => {
  const r = parseRunArgs(["--new-pane", "--prompt-file", "/tmp/p.txt", "claude"]);
  expect(r).toMatchObject({ kind: "inline", placement: "new-pane", promptFile: "/tmp/p.txt" });
});

test("--prompt and --prompt-file are mutually exclusive", () => {
  const r = parseRunArgs(["--new-pane", "--prompt", "x", "--prompt-file", "/tmp/p.txt", "claude"]);
  expect(r.kind).toBe("error");
  if (r.kind === "error") expect(r.message).toMatch(/cannot combine --prompt with --prompt-file/);
});

test("--prompt requires a value", () => {
  const r = parseRunArgs(["--new-pane", "--prompt"]);
  expect(r.kind).toBe("error");
  if (r.kind === "error") expect(r.message).toMatch(/--prompt requires a value/);
});

test("no prompt flag → prompt/promptFile absent", () => {
  const r = parseRunArgs(["claude"]);
  expect(r).toMatchObject({ kind: "inline" });
  if (r.kind === "inline") { expect(r.prompt).toBeUndefined(); expect(r.promptFile).toBeUndefined(); }
});

// ---- headless placement ----

test("--headless sets the headless placement", () => {
  const r = parseRunArgs(["-p", "POSM", "--headless", "--prompt", "hi"]);
  expect(r).toEqual({
    kind: "profile", profileName: "POSM", placement: "headless",
    detach: false, wrapped: false, direct: false, printCoords: false, prompt: "hi", promptFile: undefined,
  });
});

test("--headless accepts --prompt-file", () => {
  const r = parseRunArgs(["-p", "POSM", "--headless", "--prompt-file", "p.txt"]);
  expect(r.kind).toBe("profile");
  if (r.kind === "profile") {
    expect(r.placement).toBe("headless");
    expect(r.promptFile).toBe("p.txt");
  }
});

test("--headless without a prompt is an error", () => {
  const r = parseRunArgs(["-p", "POSM", "--headless"]);
  expect(r.kind).toBe("error");
  if (r.kind === "error") expect(r.message).toMatch(/--headless requires --prompt/);
});

test("--headless cannot combine with a tmux placement", () => {
  const r = parseRunArgs(["-p", "POSM", "--headless", "--new-window", "--prompt", "hi"]);
  expect(r.kind).toBe("error");
  if (r.kind === "error") expect(r.message).toMatch(/cannot combine/);
});

test("--headless cannot combine with --detach", () => {
  const r = parseRunArgs(["-p", "POSM", "--headless", "--prompt", "hi", "-d"]);
  expect(r.kind).toBe("error");
  if (r.kind === "error") expect(r.message).toMatch(/cannot combine --headless with -d/);
});

test("-d before --headless still errors (soft default does not win)", () => {
  const r = parseRunArgs(["-p", "POSM", "-d", "--headless", "--prompt", "hi"]);
  expect(r.kind).toBe("error");
  if (r.kind === "error") expect(r.message).toMatch(/cannot combine --headless with -d/);
});

test("--headless works in inline mode", () => {
  const r = parseRunArgs(["--headless", "--prompt", "hi", "claude"]);
  expect(r.kind).toBe("inline");
  if (r.kind === "inline") {
    expect(r.placement).toBe("headless");
    expect(r.agent_kind).toBe("claude");
  }
});

test("the --prompt-without-placement error now mentions --headless", () => {
  const r = parseRunArgs(["-p", "POSM", "--prompt", "hi"]);
  expect(r.kind).toBe("error");
  if (r.kind === "error") expect(r.message).toMatch(/--headless/);
});

test("--direct --print-coords --cwd parses to print-coords placement", () => {
  const r = parseRunArgs(["--direct", "--print-coords", "--cwd", "/w", "--", "claude", "--x"]);
  expect(r).toMatchObject({
    kind: "inline", command: "claude", args: ["--x"], placement: "print-coords",
    direct: true, printCoords: true, cwd: "/w", detach: true,
  });
});

test("--print-coords conflicts", () => {
  expect(parseRunArgs(["--print-coords", "--", "claude"]).kind).toBe("error");
  expect(parseRunArgs(["--direct", "--print-coords", "--new-pane", "--", "claude"]).kind).toBe("error");
  expect(parseRunArgs(["--direct", "--print-coords", "--headless", "--prompt", "x", "--", "claude"]).kind).toBe("error");
  expect(parseRunArgs(["--direct", "--wrapped", "--", "claude"]).kind).toBe("error");
});

test("--cwd and --direct are plain run flags", () => {
  expect(parseRunArgs(["--cwd", "/w", "-p", "p"])).toMatchObject({ kind: "profile", cwd: "/w", direct: false, printCoords: false });
  expect(parseRunArgs(["--cwd"]).kind).toBe("error");
});

const R = { name: "ai-sandbox", sandbox: "wi-1" };

test("--remote --sandbox with no command or -p → remote-default", () => {
  expect(parseRunArgs(["--remote", "ai-sandbox", "--sandbox", "wi-1"]))
    .toEqual({ kind: "remote-default", remote: R, placement: "inherit", detach: false });
  expect(parseRunArgs(["--remote", "ai-sandbox", "--sandbox", "wi-1", "--kind", "codex"]))
    .toMatchObject({ kind: "remote-default", agent_kind: "codex", remote: R });
});

test("--remote carries onto -p and positional runs", () => {
  expect(parseRunArgs(["--remote", "ai-sandbox", "--sandbox", "wi-1", "-p", "x"]))
    .toMatchObject({ kind: "profile", profileName: "x", remote: R });
  expect(parseRunArgs(["--sandbox", "wi-1", "--remote", "ai-sandbox", "--kind", "codex", "--", "codex", "--y"]))
    .toMatchObject({ kind: "inline", agent_kind: "codex", command: "codex", args: ["--y"], remote: R });
});

test("--remote and --sandbox go together", () => {
  for (const a of [["--remote", "ai-sandbox"], ["--sandbox", "wi-1"]]) {
    const r = parseRunArgs(a);
    expect(r).toEqual({ kind: "error", message: "--remote and --sandbox go together" });
  }
});

test("--remote / --sandbox names outside [A-Za-z0-9._-] are rejected", () => {
  for (const bad of ["a b", "a;b", "$HOME", "a/b", "", "x".repeat(65)]) {
    const r = parseRunArgs(["--remote", "ai-sandbox", "--sandbox", bad]);
    expect(r.kind).toBe("error");
  }
  expect(parseRunArgs(["--remote", "a;b", "--sandbox", "wi-1"])).toEqual({ kind: "error", message: "--remote must match [A-Za-z0-9._-]+" });
  expect(parseRunArgs(["--remote", "r", "--sandbox", "a b"])).toEqual({ kind: "error", message: "--sandbox must match [A-Za-z0-9._-]{1,64}" });
  expect(parseRunArgs(["--remote", "r", "--sandbox", "x".repeat(64)]).kind).toBe("remote-default");
});

test("--remote rejects the sandbox-side flags", () => {
  for (const f of ["--wrapped", "--direct", "--print-coords"]) {
    expect(parseRunArgs(["--remote", "r", "--sandbox", "s", f])).toEqual({ kind: "error", message: `cannot combine --remote with ${f}` });
  }
});

test("--remote: --prompt needs no local placement; --headless and -d rules still apply", () => {
  expect(parseRunArgs(["--remote", "r", "--sandbox", "s", "--prompt", "hi"]))
    .toMatchObject({ kind: "remote-default", prompt: "hi", placement: "inherit" });
  expect(parseRunArgs(["--remote", "r", "--sandbox", "s", "--headless", "--prompt-file", "/p"]))
    .toMatchObject({ kind: "remote-default", promptFile: "/p", placement: "headless" });
  expect(parseRunArgs(["--remote", "r", "--sandbox", "s", "--headless"]).kind).toBe("error");
  expect(parseRunArgs(["--remote", "r", "--sandbox", "s", "-d", "--headless", "--prompt", "x"]).kind).toBe("error");
  expect(parseRunArgs(["--remote", "r", "--sandbox", "s", "-d", "--cwd", "/o"]))
    .toMatchObject({ kind: "remote-default", detach: true, cwd: "/o" });
});
