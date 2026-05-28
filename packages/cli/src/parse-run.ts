// Parse the argv tail after `agmux run`. Two modes:
//   - profile  → -p / --profile <name>
//   - inline   → first positional is the command, rest are args
// agent_kind for inline mode: --kind=<k> wins; else basename heuristic
// ("claude" → claude, "codex" → codex); else error.
//
// Placement: where to launch the agent's tmux pane.
//   - "inherit"     → today's behavior (hijack current pane if in tmux,
//                     else create the agmux session and attach).
//   - "new-pane"    → split the current tmux pane.
//                     Requires the caller to be inside tmux.
//   - "new-window"  → create a new window. Defaults to the caller's current
//                     tmux session; falls back to AGMUX_TMUX_SESSION otherwise.
//   - "new-session" → create a fresh detached tmux session.
//
// detach: -d/--detach. Means "spawn but don't move me there." Without it, the
// new pane/window/session becomes the active one (the default for any explicit
// --new-* placement is to follow the new spawn).

export type Placement = "inherit" | "new-pane" | "new-window" | "new-session";

export type ParsedRun =
  | { kind: "profile"; profileName: string; placement: Placement; detach: boolean }
  | { kind: "inline"; agent_kind: "claude" | "codex"; command: string; args: string[]; placement: Placement; detach: boolean }
  | { kind: "error"; message: string };

function parseKind(v: string): "claude" | "codex" | null {
  return v === "claude" || v === "codex" ? v : null;
}

export function parseRunArgs(argv: string[]): ParsedRun {
  let profileName: string | undefined;
  let kindFlag: "claude" | "codex" | undefined;
  let placement: Placement = "inherit";
  let detach = false;
  // Track *explicit* --new-* selection so we can error on collisions; -d's
  // default ("--new-pane unless overridden") never collides on its own.
  let explicitPlacementFlag: string | null = null;
  let i = 0;

  while (i < argv.length) {
    const a = argv[i]!;
    if (a === "--") { i++; break; }
    if (a === "-p" || a === "--profile") {
      const name = argv[i + 1];
      if (!name) return { kind: "error", message: `${a} requires a value` };
      profileName = name;
      i += 2;
      continue;
    }
    if (a === "--kind") {
      const v = argv[i + 1];
      const k = v ? parseKind(v) : null;
      if (!k) return { kind: "error", message: `--kind must be 'claude' or 'codex'` };
      kindFlag = k;
      i += 2;
      continue;
    }
    if (a.startsWith("--kind=")) {
      const k = parseKind(a.slice("--kind=".length));
      if (!k) return { kind: "error", message: `--kind must be 'claude' or 'codex'` };
      kindFlag = k;
      i += 1;
      continue;
    }
    if (a === "-d" || a === "--detach") {
      detach = true;
      // Soft default: only fills placement if no explicit --new-* was given (yet
      // or later). Without explicit override, this means --new-pane.
      if (placement === "inherit") placement = "new-pane";
      i += 1;
      continue;
    }
    if (a === "--new-pane" || a === "--new-window" || a === "--new-session") {
      const p: Placement =
        a === "--new-pane" ? "new-pane" :
        a === "--new-window" ? "new-window" :
        "new-session";
      if (explicitPlacementFlag && explicitPlacementFlag !== a) {
        return { kind: "error", message: `cannot combine ${explicitPlacementFlag} with ${a}` };
      }
      explicitPlacementFlag = a;
      placement = p;
      i += 1;
      continue;
    }
    break;
  }

  const tail = argv.slice(i);

  if (profileName) {
    if (tail.length > 0) {
      return { kind: "error", message: "cannot combine -p/--profile with a positional command" };
    }
    return { kind: "profile", profileName, placement, detach };
  }

  if (tail.length === 0) {
    return { kind: "error", message: "agmux run: needs a command or -p <profile>" };
  }

  const command = tail[0]!;
  const args = tail.slice(1);
  const basename = command.split("/").pop() ?? command;
  const detected: "claude" | "codex" | undefined =
    basename === "claude" ? "claude" :
    basename === "codex" ? "codex" :
    undefined;
  const agent_kind = kindFlag ?? detected;
  if (!agent_kind) {
    return {
      kind: "error",
      message: `agmux run: cannot infer agent_kind from '${basename}'. Use --kind=claude or --kind=codex.`,
    };
  }
  return { kind: "inline", agent_kind, command, args, placement, detach };
}
