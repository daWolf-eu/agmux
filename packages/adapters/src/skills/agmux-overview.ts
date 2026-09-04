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

## Running an agent without a terminal

    agmux run -p <profile> --headless --prompt "summarize the diff"

That runs one non-interactive turn: no tmux pane, no PTY. The agent's stdout is
streamed straight to yours and the exit code is the agent's, so it composes with
pipes and redirection:

    agmux run -p <profile> --headless --prompt "..." > report.md
    agmux run -p <profile> --headless --prompt-file ./task.md

Notes:

- --headless is a placement, so it cannot be combined with --new-pane /
  --new-window / --new-session, nor with -d/--detach.
- It requires --prompt or --prompt-file, and is supported for the claude and
  codex kinds (pi errors out rather than hanging).
- A headless run is a fully recorded session, not a throwaway: it shows up in
  agmux ls / inspect with cost and usage, and agmux attach relaunches it as a
  resumed interactive session afterwards.

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
    "or how to list, inspect, or watch agmux sessions, or how to run a prompt " +
    "non-interactively with agmux run --headless.",
  body,
};
