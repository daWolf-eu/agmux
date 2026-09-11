import { test, expect } from "bun:test";
import { resolveNotifier, buildNotifyArgv, type NotifySpec } from "../src/notifier.ts";

const SPEC: NotifySpec = { title: "agmux", body: "work:2 needs permission", sound: "Ping", attachId: "agx-1" };

test("auto prefers terminal-notifier when present", () => {
  expect(resolveNotifier("auto", (b) => b === "terminal-notifier")).toBe("terminal-notifier");
});

test("auto falls back to osascript on macOS when terminal-notifier is absent", () => {
  expect(resolveNotifier("auto", (b) => b === "osascript")).toBe("osascript");
});

test("auto falls back to notify-send when only that exists", () => {
  expect(resolveNotifier("auto", (b) => b === "notify-send")).toBe("notify-send");
});

test("auto yields null when nothing is available", () => {
  expect(resolveNotifier("auto", () => false)).toBe(null);
});

test("an explicit choice is honoured even if other binaries exist", () => {
  expect(resolveNotifier("osascript", () => true)).toBe("osascript");
});

test("an explicit choice that is not installed yields null rather than silently substituting", () => {
  expect(resolveNotifier("terminal-notifier", () => false)).toBe(null);
});

test("a custom command string is passed through", () => {
  expect(resolveNotifier("/usr/local/bin/my-notify", () => false)).toBe("custom");
});

test("terminal-notifier argv carries sound and a click-to-attach execute action", () => {
  const { cmd, args } = buildNotifyArgv("terminal-notifier", SPEC);
  expect(cmd).toBe("terminal-notifier");
  expect(args).toContain("-sound");
  expect(args).toContain("Ping");
  expect(args.join(" ")).toContain("agmux attach agx-1");
});

test("osascript argv embeds sound and escapes double quotes in the body", () => {
  const { cmd, args } = buildNotifyArgv("osascript", { ...SPEC, body: 'say "hi"' });
  expect(cmd).toBe("osascript");
  expect(args[0]).toBe("-e");
  expect(args[1]).toContain('sound name "Ping"');
  expect(args[1]).toContain('say \\"hi\\"');
});

test("a null sound omits the sound clause entirely", () => {
  const { args } = buildNotifyArgv("osascript", { ...SPEC, sound: null });
  expect(args[1]).not.toContain("sound name");
});

test("a custom command substitutes the documented variables", () => {
  const { cmd, args } = buildNotifyArgv("custom", SPEC, "/bin/n --title {title} --body {body} --id {session_id}");
  expect(cmd).toBe("/bin/n");
  expect(args).toEqual(["--title", "agmux", "--body", "work:2 needs permission", "--id", "agx-1"]);
});

test("a blank configured string resolves to null", () => {
  expect(resolveNotifier("", () => true)).toBe(null);
});

test("whitespace-only configured string resolves to null", () => {
  expect(resolveNotifier("   ", () => true)).toBe(null);
});

test("notify-send argv carries title and body only, ignoring attachId and sound", () => {
  const { cmd, args } = buildNotifyArgv("notify-send", SPEC);
  expect(cmd).toBe("notify-send");
  expect(args).toEqual(["agmux", "work:2 needs permission"]);
});

test("osascript escapes a body ending with a single backslash", () => {
  const { args } = buildNotifyArgv("osascript", { ...SPEC, body: "ends with backslash\\" });
  // The body should be escaped so the closing quote is not escaped
  expect(args[1]).toContain('ends with backslash\\\\');
  expect(args[1]).toMatch(/"ends with backslash\\\\".*with title/);
});

test("osascript escapes a body containing a lone double quote", () => {
  const { args } = buildNotifyArgv("osascript", { ...SPEC, body: 'contains " quote' });
  expect(args[1]).toContain('contains \\" quote');
});

test("osascript escapes an AppleScript injection attempt", () => {
  const { args } = buildNotifyArgv("osascript", { ...SPEC, body: '" & (do shell script "id") & "' });
  // All quotes should be escaped, keeping the injection attempt inside the string literal
  expect(args[1]).toContain('\\" & (do shell script \\"id\\") & \\"');
});
