import type { SkillDef } from "./types.ts";

const body = `# Troubleshooting agmux

Use this when agmux seems to be missing events, the hub looks down, or an
adapter looks misconfigured.

## Is this session being recorded?

    agmux inspect "$AGMUX_SESSION_ID"

If that errors or shows nothing, events from this session are not reaching the
hub.

## Check the adapter install

agmux delivers its telemetry hooks through a per-agent adapter. Check it:

    agmux adapter status <profile>        # or: --kind claude|codex|pi

- "not installed": run agmux adapter install <profile> (or --kind ...).
- "[drift]": the installed payload is stale; reinstall to refresh it.

## Is the hub reachable?

The hub is the local daemon that ingests events. Its URL is in the
AGMUX_HUB_URL environment variable (a localhost address). If events are not
landing, confirm the hub process is running and that URL is reachable.

## Where agmux keeps state

- ~/.agmux/ is the state directory.
- ~/.agmux/cursors/ holds per-session transcript cursors.
- When the hub is unreachable, events are buffered in an on-disk queue and
  flushed on the next successful post.

## Common causes

- Hooks not firing: the agent's hook-trust prompt may not have been accepted
  for this config dir; the first session after install can be ungated.
- AGMUX_SESSION_ID unset: the session was launched outside agmux. For
  adapter-backed kinds, native self-registration still applies.
`;

export const AGMUX_TROUBLESHOOTING: SkillDef = {
  name: "agmux-troubleshooting",
  description:
    "Diagnoses agmux when events look missing, the hub seems down, or an adapter is misconfigured. " +
    "Use when agmux is not recording, sessions do not appear in agmux ls or agmux inspect, " +
    "adapter status shows drift, or AGMUX_SESSION_ID is unset.",
  body,
};
