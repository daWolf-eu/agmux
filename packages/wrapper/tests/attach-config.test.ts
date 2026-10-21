import { test, expect } from "bun:test";
import { parseAttachSection } from "../src/profile.ts";

test("missing sections yield an empty config", () => {
  expect(parseAttachSection(undefined, undefined)).toEqual({ terminal: {}, remote: {} });
});

test("valid [attach] and [terminal] parse", () => {
  expect(parseAttachSection(
    { live: "new-tab", closed: "new-session" },
    { new_window: ["open", "-na", "Ghostty.app", "--args", "-e", "{cmd}"], new_tab: [] },
  )).toEqual({
    live: "new-tab", closed: "new-session",
    terminal: { newWindow: ["open", "-na", "Ghostty.app", "--args", "-e", "{cmd}"] }, remote: {},
  });
});

test("an empty template array means unset", () => {
  expect(parseAttachSection(undefined, { new_tab: [] })).toEqual({ terminal: {}, remote: {} });
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

test("view_detach_key is gone with the live view", () => {
  expect(() => parseAttachSection({ view_detach_key: "M-d" }, undefined)).toThrow(/\[attach\] unknown key "view_detach_key"/);
});

test("[attach.remote] parses", () => {
  expect(parseAttachSection(
    { remote: { placement: "new-pane", mode: "full", window_name: "R {title}", detach_key: "C-q" } }, undefined,
  ).remote).toEqual({ placement: "new-pane", mode: "full", windowName: "R {title}", detachKey: "C-q" });
});

test("missing [attach.remote] is an empty table", () => {
  expect(parseAttachSection(undefined, undefined).remote).toEqual({});
});

test("invalid [attach.remote] throws naming the table", () => {
  for (const remote of [{ bogus: 1 }, { mode: "toggle" }, { detach_key: "M-d;x" }, { placement: "nowhere" }, { window_name: "" }])
    expect(() => parseAttachSection({ remote }, undefined)).toThrow(/\[attach\.remote\]/);
});
