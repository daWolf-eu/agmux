import { test, expect } from "bun:test";
import { parseAgentTitle, TitleSignal, validateKnownPayload } from "../src/index.ts";

test("claude: braille spinner = working, ✳ = idle, both carry the session name", () => {
  expect(parseAgentTitle("claude", "⠂ fix flaky tests")).toEqual({ activity: "working", name: "fix flaky tests" });
  expect(parseAgentTitle("claude", "✳ fix flaky tests")).toEqual({ activity: "idle", name: "fix flaky tests" });
  expect(parseAgentTitle("claude", "zsh")).toEqual({ activity: null, name: "zsh" });
});

test("a braille character later in the title is not a spinner", () => {
  expect(parseAgentTitle("claude", "notes ⠂ x").activity).toBeNull();
});

test("codex/pi: spinner = working; no verified idle marker", () => {
  expect(parseAgentTitle("codex", "⠇ refactor auth").activity).toBe("working");
  expect(parseAgentTitle("codex", "✳ refactor auth").activity).toBeNull();
  expect(parseAgentTitle("pi", "⠋ x").activity).toBe("working");
});

test("TitleSignal: spinner frames are one event; changes and keepalives are sent", () => {
  const s = new TitleSignal("claude", 60_000);
  expect(s.observe("⠂ task", 0)).toEqual({ title: "task", activity: "working" });
  expect(s.observe("⠄ task", 100)).toBeNull();          // next frame
  expect(s.observe("⠆ task", 59_000)).toBeNull();
  expect(s.observe("⠂ task", 60_000)).toEqual({ title: "task", activity: "working" }); // keepalive
  expect(s.observe("✳ task", 60_100)).toEqual({ title: "task", activity: "idle" });
  expect(s.observe("✳ task", 999_999)).toBeNull();      // idle needs no keepalive
  expect(s.observe("✳ renamed", 1_000_000)).toEqual({ title: "renamed", activity: "idle" });
});

test("validators: tool.started, title.changed, question, focus", () => {
  expect(validateKnownPayload("tool.started", { tool: "Bash" }).ok).toBe(true);
  expect(validateKnownPayload("tool.started", {}).ok).toBe(false);
  expect(validateKnownPayload("title.changed", { title: "x", activity: "working" }).ok).toBe(true);
  expect(validateKnownPayload("title.changed", { title: "x", activity: null }).ok).toBe(true);
  expect(validateKnownPayload("title.changed", { title: "x", activity: "busy" }).ok).toBe(false);
  expect(validateKnownPayload("input.required", { kind: "question" }).ok).toBe(true);
  expect(validateKnownPayload("session.seen", { source: "focus" }).ok).toBe(true);
  expect(validateKnownPayload("session.seen", { source: "nope" }).ok).toBe(false);
});
