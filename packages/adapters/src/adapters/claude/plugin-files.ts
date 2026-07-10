// The agmux Claude plugin payload, embedded as code. install() WRITES these
// files instead of copying a directory so the adapter works identically from
// source and from a `bun build --compile` binary (where import.meta.dir points
// into the virtual /$bunfs and on-disk data files don't exist).

export const PLUGIN_VERSION = "1.3.0";

const EMIT = "${AGMUX_BIN:-agmux} emit --from=claude";

const PLUGIN_MANIFEST = {
  name: "agmux",
  description: "agmux session telemetry integration",
  version: PLUGIN_VERSION,
};

// Hook wiring (spec §3.1): all async so they never delay Claude; commands run
// via shell so ${AGMUX_BIN:-agmux} and $AGMUX_SESSION_ID expand at fire time.
const HOOKS = {
  hooks: {
    SessionStart: [
      {
        // startup|resume|clear|compact: /clear and compaction rotate the native
        // session id mid-process; re-registering on each keeps the mapping current
        // (resolveIngest rule 3 = pid rotation). AGMUX_AGENT_PID=$PPID captures the
        // agent pid — the hook shell's parent IS the claude process (spec §8).
        matcher: "startup|resume|clear|compact",
        hooks: [
          { type: "command", async: true, command: `AGMUX_AGENT_PID=$PPID ${EMIT} --source=hook-command --point=session.registered` },
          { type: "command", async: true, command: `${EMIT} --attach` },
        ],
      },
    ],
    UserPromptSubmit: [
      {
        hooks: [
          { type: "command", async: true, command: `${EMIT} --source=hook-command --point=turn.started` },
          { type: "command", async: true, command: `${EMIT} --source=hook-command --point=prompt.sent` },
        ],
      },
    ],
    Stop: [
      {
        hooks: [
          { type: "command", async: true, command: `${EMIT} --source=hook-command --point=turn.ended` },
          { type: "command", async: true, command: `${EMIT} --source=transcript-delta --point=usage.reported --cursor-file="$HOME/.agmux/cursors/claude-$AGMUX_SESSION_ID.cursor"` },
        ],
      },
    ],
    Notification: [
      {
        hooks: [
          { type: "command", async: true, command: `${EMIT} --source=hook-command --point=input.required` },
        ],
      },
    ],
    PostToolUse: [
      {
        matcher: "*",
        hooks: [
          { type: "command", async: true, command: `${EMIT} --source=hook-command --point=tool.used` },
        ],
      },
    ],
    // Fires BEFORE a context compaction — records the compaction as its own
    // telemetry event. Distinct from the SessionStart `compact` matcher above,
    // which re-registers the rotated native id (resolveIngest rule 3); this only
    // logs that a compaction happened.
    PreCompact: [
      {
        hooks: [
          { type: "command", async: true, command: `${EMIT} --source=hook-command --point=compaction` },
        ],
      },
    ],
  },
};

const SHIM = `#!/usr/bin/env bash
# Plugin bin/ is on PATH for hook execution; this shim lets hooks call a stable
# name while resolving the real agmux binary (AGMUX_BIN injected by the wrapper,
# else PATH lookup).
exec "\${AGMUX_BIN:-agmux}" emit "$@"
`;

export interface PluginFile {
  path: string;  // relative to the plugin root
  content: string;
  mode: number;
}

export const PLUGIN_FILES: PluginFile[] = [
  { path: ".claude-plugin/plugin.json", content: JSON.stringify(PLUGIN_MANIFEST, null, 2) + "\n", mode: 0o644 },
  { path: "hooks/hooks.json", content: JSON.stringify(HOOKS, null, 2) + "\n", mode: 0o644 },
  { path: "bin/agmux-emit", content: SHIM, mode: 0o755 },
];
