import type { AgentKind } from "@agmux/protocol";

// Per-kind install-time skill surface — one source feeding both the docs matrix
// and the conformance test. mechanism "runtime-flag"/"none" are reserved for
// kinds without an install-time dir (see spec scope B); none used this branch.
export interface SkillSurface {
  installTime: boolean;
  mechanism: "plugin-skills-dir" | "personal-skills-dir" | "skills-dir" | "runtime-flag" | "none";
  isolation: "config-dir" | "host-global" | "n/a";
  label: string; // how the skill is labeled in the agent's skill list
  note?: string;
}

export const SKILL_SURFACES: Record<AgentKind, SkillSurface> = {
  claude: { installTime: true, mechanism: "plugin-skills-dir", isolation: "config-dir", label: "agmux:<name>" },
  codex: {
    installTime: true, mechanism: "personal-skills-dir", isolation: "host-global", label: "<name>",
    note: "discovered from $HOME/.agents/skills, not CODEX_HOME-scoped",
  },
  pi: { installTime: true, mechanism: "skills-dir", isolation: "config-dir", label: "<name>" },
};
