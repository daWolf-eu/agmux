import { test, expect } from "bun:test";
import { HELP_TEXT } from "../src/usage.ts";

test("HELP_TEXT lists every user-facing verb", () => {
  for (const verb of ["run", "ls", "watch", "dash", "attach", "kill", "inspect", "adapter", "hub"]) {
    expect(HELP_TEXT).toContain(`\n  ${verb} `);
  }
});

test("HELP_TEXT documents -h/--help and -v/--version", () => {
  expect(HELP_TEXT).toContain("-h, --help");
  expect(HELP_TEXT).toContain("-v, --version");
});

test("HELP_TEXT does not advertise the internal emit verb", () => {
  expect(HELP_TEXT).not.toContain("emit");
});

test("dash --preview help matches the parser (mirror|detail, no events)", () => {
  expect(HELP_TEXT).toContain("--preview <mirror|detail>");
  expect(HELP_TEXT).not.toContain("events");
});
