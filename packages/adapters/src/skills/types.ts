// One agmux-authored skill, agent-agnostic. compose() turns this into a SKILL.md.
// Authored as embedded code (catalog + body files) so it works identically from
// source and from a `bun build --compile` binary (cf. plugin-files.ts).
export interface SkillDef {
  name: string;        // dir name + frontmatter `name`; also the flat label on Codex/Pi
  description: string; // frontmatter `description`; drives triggering; keep <=1536 chars
  body: string;        // SKILL.md markdown WITHOUT frontmatter (compose adds it)
}
