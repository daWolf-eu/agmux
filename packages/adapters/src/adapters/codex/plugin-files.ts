// The agmux Codex plugin payload, embedded as code (cf. claude/plugin-files.ts).
// install() WRITES these files to a stable dir and registers it as a LOCAL
// marketplace, so the adapter works identically from source and from a
// `bun build --compile` binary (where import.meta.dir is virtual). No published
// package, no network — the only externality is the `codex` binary on PATH.

export const PLUGIN_VERSION = "1.0.1";
export const MARKETPLACE_NAME = "agmux";
export const PLUGIN_NAME = "agmux";

// Hooks run via shell so ${AGMUX_BIN:-agmux} and $AGMUX_SESSION_ID expand at fire
// time; --from=codex selects this adapter's normalize() inside `agmux emit`.
const EMIT = "${AGMUX_BIN:-agmux} emit --from=codex";

// codex 0.135 does NOT support `async:true` hooks — it warns "async hooks are not
// supported yet" and SKIPS them, so an async hook silently never fires. To keep
// the non-blocking intent we use SYNCHRONOUS command hooks that fork the work into
// a subshell and return immediately: `( <cmd> & )` exits as soon as the job is
// backgrounded. Safe for every point here — these emits are fire-and-forget
// telemetry that return no decision to Codex.
const bg = (cmd: string) => `( ${cmd} & )`;

const MARKETPLACE_MANIFEST = {
  name: MARKETPLACE_NAME,
  interface: { displayName: "agmux" },
  plugins: [
    {
      name: PLUGIN_NAME,
      source: { source: "local", path: "./plugins/agmux" },
      policy: { installation: "AVAILABLE" },
    },
  ],
};

const PLUGIN_MANIFEST = {
  name: PLUGIN_NAME,
  version: PLUGIN_VERSION,
  description: "agmux session telemetry integration",
  hooks: "./hooks/hooks.json",
};

// Hook wiring (spec §3.1): non-blocking via bg() self-fork (see above; codex has
// no async-hook support). session.registered captures the agent pid via $PPID (the
// hook shell's parent is the codex process).
const HOOKS = {
  hooks: {
    SessionStart: [
      {
        matcher: "startup|resume|clear|compact",
        hooks: [
          { type: "command", command: bg(`AGMUX_AGENT_PID=$PPID ${EMIT} --source=hook-command --point=session.registered`) },
          { type: "command", command: bg(`${EMIT} --attach`) },
        ],
      },
    ],
    UserPromptSubmit: [
      {
        hooks: [
          { type: "command", command: bg(`${EMIT} --source=hook-command --point=turn.started`) },
          { type: "command", command: bg(`${EMIT} --source=hook-command --point=prompt.sent`) },
        ],
      },
    ],
    Stop: [
      {
        hooks: [
          { type: "command", command: bg(`${EMIT} --source=hook-command --point=turn.ended`) },
          { type: "command", command: bg(`${EMIT} --source=transcript-delta --point=usage.reported --cursor-file="$HOME/.agmux/cursors/codex-$AGMUX_SESSION_ID.cursor"`) },
        ],
      },
    ],
    PermissionRequest: [
      {
        hooks: [
          { type: "command", command: bg(`${EMIT} --source=hook-command --point=input.required`) },
        ],
      },
    ],
    PostToolUse: [
      {
        matcher: "*",
        hooks: [
          { type: "command", command: bg(`${EMIT} --source=hook-command --point=tool.used`) },
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

export interface MarketplaceFile {
  path: string;  // relative to the materialized marketplace root
  content: string;
  mode: number;
}

export const MARKETPLACE_FILES: MarketplaceFile[] = [
  { path: ".agents/plugins/marketplace.json", content: JSON.stringify(MARKETPLACE_MANIFEST, null, 2) + "\n", mode: 0o644 },
  { path: "plugins/agmux/.codex-plugin/plugin.json", content: JSON.stringify(PLUGIN_MANIFEST, null, 2) + "\n", mode: 0o644 },
  { path: "plugins/agmux/hooks/hooks.json", content: JSON.stringify(HOOKS, null, 2) + "\n", mode: 0o644 },
  { path: "plugins/agmux/bin/agmux-emit", content: SHIM, mode: 0o755 },
];
