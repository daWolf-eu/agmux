import type { SkillDef } from "./types.ts";

const body = `# Using agmux

agmux records every AI agent session (Claude, Codex, Pi, and others) into one
local append-only event log and exposes it through a hub daemon. You are
running inside an agmux-tracked session right now.

## Your session id

Your canonical agmux session id is in the AGMUX_SESSION_ID environment
variable. Everything this session does is joined to it. To see your own
record:

    agmux inspect "$AGMUX_SESSION_ID"

## Seeing sessions

    agmux ls            # list recorded sessions, most recent first
    agmux watch         # fullscreen live view of the session list (TUI)
    agmux inspect <id>  # full detail for one session

Those three are read-only and safe to run at any time.

    agmux dash          # interactive session browser (TUI): grouped sessions + live preview

dash is interactive, not just a viewer - from it you can attach to, kill, or
resume a session, so use it deliberately.

## Concepts

- agent_kind: the underlying agent (claude, codex, pi).
- profile: a named launch preset (for example claude-work); many profiles map
  to one agent_kind.
- The event log is the source of truth; the live views read fast projection
  tables derived from it.
`;

export const AGMUX_OVERVIEW: SkillDef = {
  name: "agmux-overview",
  description:
    "Explains what agmux is and how to inspect your own and other recorded agent sessions. " +
    "Use when the user asks what agmux is, how this session is tracked, what their session id is, " +
    "or how to list, inspect, or watch agmux sessions.",
  body,
};
