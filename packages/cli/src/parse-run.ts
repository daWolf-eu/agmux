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
//   - "print-coords" → sandbox-side of remote starts (--print-coords, needs
//                     --direct): new detached window in the agmux session on
//                     the default socket; the coords go to stdout as JSON.
//   - "headless"    → no tmux at all: run the prompt non-interactively, stream
//                     the agent's stdout through, and exit with its exit code.
//
// detach: -d/--detach. Means "spawn but don't move me there." Without it, the
// new pane/window/session becomes the active one (the default for any explicit
// --new-* placement is to follow the new spawn).
//
// Remote: --remote <r> --sandbox <s> (both or neither) starts the agent in a
// sandbox (run-remote.ts). Placement and -d then mean the LOCAL attach; -p
// names a sandbox-side profile; --cwd is a sandbox path. With neither a command
// nor -p the launch comes from the [[remote]] entry ("remote-default").

export type Placement = "inherit" | "new-pane" | "new-window" | "new-session" | "headless" | "print-coords";

export interface RemoteTarget { name: string; sandbox: string }

type RunKind = "claude" | "codex" | "pi";

export type ParsedRun =
  | { kind: "profile"; profileName: string; placement: Placement; detach: boolean; wrapped: boolean; direct: boolean; printCoords: boolean; cwd?: string; prompt?: string; promptFile?: string; remote?: RemoteTarget }
  | { kind: "inline"; agent_kind: RunKind; command: string; args: string[]; placement: Placement; detach: boolean; wrapped: boolean; direct: boolean; printCoords: boolean; cwd?: string; prompt?: string; promptFile?: string; remote?: RemoteTarget }
  | { kind: "remote-default"; agent_kind?: RunKind; remote: RemoteTarget; placement: Placement; detach: boolean; cwd?: string; prompt?: string; promptFile?: string }
  | { kind: "error"; message: string };

// Remote names follow [[remote]] name; sandbox names are openshell's (bounded).
const REMOTE_NAME_RE = /^[A-Za-z0-9._-]+$/;
const SANDBOX_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

function parseKind(v: string): RunKind | null {
  return v === "claude" || v === "codex" || v === "pi" ? v : null;
}

export function parseRunArgs(argv: string[]): ParsedRun {
  let profileName: string | undefined;
  let kindFlag: RunKind | undefined;
  let placement: Placement = "inherit";
  let detach = false;
  let wrapped = false;
  let direct = false;
  let printCoords = false;
  let cwd: string | undefined;
  let prompt: string | undefined;
  let promptFile: string | undefined;
  let remoteName: string | undefined;
  let sandbox: string | undefined;
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
      if (!k) return { kind: "error", message: `--kind must be 'claude', 'codex', or 'pi'` };
      kindFlag = k;
      i += 2;
      continue;
    }
    if (a.startsWith("--kind=")) {
      const k = parseKind(a.slice("--kind=".length));
      if (!k) return { kind: "error", message: `--kind must be 'claude', 'codex', or 'pi'` };
      kindFlag = k;
      i += 1;
      continue;
    }
    if (a === "--remote" || a === "--sandbox") {
      const v = argv[i + 1];
      if (!v) return { kind: "error", message: `${a} requires a value` };
      if (!(a === "--remote" ? REMOTE_NAME_RE : SANDBOX_NAME_RE).test(v)) {
        return { kind: "error", message: `${a} must match ${a === "--remote" ? "[A-Za-z0-9._-]+" : "[A-Za-z0-9._-]{1,64}"}` };
      }
      if (a === "--remote") remoteName = v; else sandbox = v;
      i += 2;
      continue;
    }
    if (a === "--wrapped") { wrapped = true; i += 1; continue; }
    if (a === "--direct") { direct = true; i += 1; continue; }
    if (a === "--print-coords") { printCoords = true; i += 1; continue; }
    if (a === "--cwd") {
      const v = argv[i + 1];
      if (!v) return { kind: "error", message: `--cwd requires a non-empty value` };
      cwd = v;
      i += 2;
      continue;
    }
    if (a === "--prompt") {
      const v = argv[i + 1];
      if (v === undefined) return { kind: "error", message: `--prompt requires a value` };
      prompt = v;
      i += 2;
      continue;
    }
    if (a === "--prompt-file") {
      const v = argv[i + 1];
      if (v === undefined) return { kind: "error", message: `--prompt-file requires a value` };
      promptFile = v;
      i += 2;
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
    if (a === "--headless") {
      if (explicitPlacementFlag && explicitPlacementFlag !== a) {
        return { kind: "error", message: `cannot combine ${explicitPlacementFlag} with ${a}` };
      }
      explicitPlacementFlag = a;
      placement = "headless";
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

  if ((remoteName === undefined) !== (sandbox === undefined)) {
    return { kind: "error", message: "--remote and --sandbox go together" };
  }
  const remote = remoteName !== undefined && sandbox !== undefined ? { name: remoteName, sandbox } : undefined;
  if (remote) {
    // Sandbox-side flags: the remote run picks them itself.
    const local = wrapped ? "--wrapped" : direct ? "--direct" : printCoords ? "--print-coords" : null;
    if (local) return { kind: "error", message: `cannot combine --remote with ${local}` };
  }

  if (direct && wrapped) {
    return { kind: "error", message: "cannot combine --direct with --wrapped" };
  }
  if (printCoords) {
    if (!direct) return { kind: "error", message: "--print-coords requires --direct" };
    if (explicitPlacementFlag) {
      return { kind: "error", message: `cannot combine --print-coords with ${explicitPlacementFlag}` };
    }
    // Always detached; -d's soft new-pane default is superseded.
    placement = "print-coords";
    detach = true;
  }

  if (prompt !== undefined && promptFile !== undefined) {
    return { kind: "error", message: "cannot combine --prompt with --prompt-file" };
  }
  // A remote run always places the agent in the sandbox (or runs headless there).
  if ((prompt !== undefined || promptFile !== undefined) && placement === "inherit" && !remote) {
    return { kind: "error", message: "--prompt requires --headless, --new-pane, --new-window, or --new-session" };
  }
  if (placement === "headless" && prompt === undefined && promptFile === undefined) {
    return { kind: "error", message: "--headless requires --prompt or --prompt-file" };
  }
  // -d means "spawn but don't move me there" — meaningless with no pane to move to,
  // and its soft default (--new-pane) would silently contradict an explicit --headless.
  if (placement === "headless" && detach) {
    return { kind: "error", message: "cannot combine --headless with -d/--detach" };
  }

  if (profileName) {
    if (tail.length > 0) {
      return { kind: "error", message: "cannot combine -p/--profile with a positional command" };
    }
    return { kind: "profile", profileName, placement, detach, wrapped, direct, printCoords, cwd, prompt, promptFile, remote };
  }

  if (tail.length === 0 && remote) {
    return { kind: "remote-default", agent_kind: kindFlag, remote, placement, detach, cwd, prompt, promptFile };
  }
  if (tail.length === 0) {
    return { kind: "error", message: "agmux run: needs a command or -p <profile>" };
  }

  const command = tail[0]!;
  const args = tail.slice(1);
  const basename = command.split("/").pop() ?? command;
  const detected: RunKind | undefined =
    basename === "claude" ? "claude" :
    basename === "codex" ? "codex" :
    basename === "pi" ? "pi" :
    undefined;
  const agent_kind = kindFlag ?? detected;
  if (!agent_kind) {
    return {
      kind: "error",
      message: `agmux run: cannot infer agent_kind from '${basename}'. Use --kind=claude, --kind=codex, or --kind=pi.`,
    };
  }
  return { kind: "inline", agent_kind, command, args, placement, detach, wrapped, direct, printCoords, cwd, prompt, promptFile, remote };
}
