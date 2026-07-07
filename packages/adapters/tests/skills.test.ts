import { test, expect } from "bun:test";
import { AGENT_KINDS } from "@agmux/protocol";
import { SKILLS } from "../src/skills/catalog.ts";
import { skillFileContent } from "../src/skills/compose.ts";
import { SKILL_SURFACES } from "../src/skills/surface.ts";

test("catalog ships the two agmux self-doc skills with unique names", () => {
  const names = SKILLS.map((s) => s.name);
  expect(names).toContain("agmux-overview");
  expect(names).toContain("agmux-troubleshooting");
  expect(new Set(names).size).toBe(names.length);
});

test("every skill has non-empty fields and a budget-safe description", () => {
  for (const s of SKILLS) {
    expect(s.name.length).toBeGreaterThan(0);
    expect(s.description.length).toBeGreaterThan(0);
    expect(s.description.length).toBeLessThanOrEqual(1536); // Claude skill-listing cap
    expect(s.body.length).toBeGreaterThan(0);
    expect(s.body.includes("`")).toBe(false); // bodies avoid backticks (template-literal authoring)
  }
});

test("compose emits YAML frontmatter then the body", () => {
  const def = SKILLS[0]!;
  const md = skillFileContent(def);
  expect(md.startsWith("---\n")).toBe(true);
  expect(md).toContain(`name: ${def.name}\n`);
  expect(md).toContain(`description: ${JSON.stringify(def.description)}\n`);
  expect(md).toContain("\n---\n\n");
  expect(md.trimEnd().endsWith(def.body.trimEnd())).toBe(true);
});

test("every agent_kind has a skill-surface descriptor; all three deliver at install time", () => {
  for (const k of AGENT_KINDS) {
    expect(SKILL_SURFACES[k]).toBeDefined();
    expect(typeof SKILL_SURFACES[k]!.installTime).toBe("boolean");
  }
  expect(SKILL_SURFACES.claude).toMatchObject({ installTime: true, isolation: "config-dir" });
  expect(SKILL_SURFACES.codex).toMatchObject({ installTime: true, isolation: "host-global" });
  expect(SKILL_SURFACES.pi).toMatchObject({ installTime: true, isolation: "config-dir" });
});
