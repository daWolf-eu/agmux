import type { SkillDef } from "./types.ts";
import { AGMUX_OVERVIEW } from "./agmux-overview.ts";
import { AGMUX_TROUBLESHOOTING } from "./agmux-troubleshooting.ts";

// THE single source of truth for agmux-shipped skills. Every adapter's install()
// materializes this list into the agent's auto-discovered skill location.
export const SKILLS: SkillDef[] = [AGMUX_OVERVIEW, AGMUX_TROUBLESHOOTING];
