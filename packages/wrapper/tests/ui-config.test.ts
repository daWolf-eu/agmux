import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadUiConfig, parseUiSection } from "../src/profile.ts";

test("missing [ui] yields an empty config", () => {
  expect(parseUiSection(undefined)).toEqual({});
});

test("remote_mark takes a one- or two-cell mark", () => {
  expect(parseUiSection({ remote_mark: "\uf0c2" })).toEqual({ remoteMark: "\uf0c2" });
  expect(parseUiSection({ remote_mark: "R" })).toEqual({ remoteMark: "R" });
  expect(parseUiSection({ remote_mark: "@@" })).toEqual({ remoteMark: "@@" });
});

test("invalid [ui] values throw, naming the key", () => {
  for (const bad of ["", " ", "abc", "\u001b[31m", 5]) {
    expect(() => parseUiSection({ remote_mark: bad })).toThrow("[ui] remote_mark");
  }
  expect(() => parseUiSection({ nope: 1 })).toThrow("[ui] unknown key");
  expect(() => parseUiSection("x")).toThrow("[ui] must be a table");
});

test("loadUiConfig reads [ui] from the file, TOML escapes included", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agmux-ui-"));
  const f = path.join(dir, "config.toml");
  expect(loadUiConfig(f)).toEqual({});
  fs.writeFileSync(f, '[ui]\nremote_mark = "\\uf0c2"\n');
  expect(loadUiConfig(f)).toEqual({ remoteMark: "\uf0c2" });
  fs.rmSync(dir, { recursive: true, force: true });
});
