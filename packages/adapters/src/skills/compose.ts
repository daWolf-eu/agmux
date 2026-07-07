import * as fs from "node:fs";
import * as path from "node:path";
import type { SkillDef } from "./types.ts";
import { SKILLS } from "./catalog.ts";

// Compose a SKILL.md (YAML frontmatter + body). The description is JSON.stringify'd
// so colons/quotes can never break the YAML; JSON strings are valid YAML scalars.
export function skillFileContent(def: SkillDef): string {
  return `---\nname: ${def.name}\ndescription: ${JSON.stringify(def.description)}\n---\n\n${def.body.trimEnd()}\n`;
}

// Materialize every catalog skill under baseDir as <baseDir>/<name>/SKILL.md.
// Returns baseDir so the caller can record it as a single uninstall artifact.
export function writeSkills(baseDir: string, skills: SkillDef[] = SKILLS): string {
  for (const def of skills) {
    const target = path.join(baseDir, def.name, "SKILL.md");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, skillFileContent(def), { mode: 0o644 });
  }
  return baseDir;
}
