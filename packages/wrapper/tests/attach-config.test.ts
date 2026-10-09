import { test, expect } from "bun:test";
import { parseAttachSection } from "../src/profile.ts";

test("missing sections yield an empty config", () => {
  expect(parseAttachSection(undefined, undefined)).toEqual({ terminal: {} });
});

test("valid [attach] and [terminal] parse", () => {
  expect(parseAttachSection(
    { live: "new-window", closed: "new-session", view_detach_key: "M-q" },
    { new_window: ["open", "-na", "Ghostty.app", "--args", "-e", "{cmd}"], new_tab: [] },
  )).toEqual({
    live: "new-window", closed: "new-session", viewDetachKey: "M-q",
    terminal: { newWindow: ["open", "-na", "Ghostty.app", "--args", "-e", "{cmd}"] },
  });
});

test("an empty template array means unset", () => {
  expect(parseAttachSection(undefined, { new_tab: [] })).toEqual({ terminal: {} });
});

test("unknown placement throws", () => {
  expect(() => parseAttachSection({ live: "window" }, undefined)).toThrow(/\[attach\] live must be one of/);
});

test("unknown keys throw", () => {
  expect(() => parseAttachSection({ lvie: "inline" }, undefined)).toThrow(/\[attach\] unknown key "lvie"/);
  expect(() => parseAttachSection(undefined, { window: ["x"] })).toThrow(/\[terminal\] unknown key "window"/);
});

test("a template without {cmd} throws", () => {
  expect(() => parseAttachSection(undefined, { new_window: ["open", "-na", "Ghostty.app"] }))
    .toThrow(/\[terminal\] new_window must contain \{cmd\}/);
});

test("a template with a non-string element throws", () => {
  expect(() => parseAttachSection(undefined, { new_window: ["open", 3, "{cmd}"] }))
    .toThrow(/\[terminal\] new_window must be an array of non-empty strings/);
});

test("view_detach_key must be a non-empty string", () => {
  expect(() => parseAttachSection({ view_detach_key: "" }, undefined)).toThrow(/view_detach_key/);
});
