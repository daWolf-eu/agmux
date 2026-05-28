// Parse the argv tail after `agmux run`. Two modes:
//   - profile  → -p / --profile <name>
//   - inline   → first positional is the command, rest are args
// agent_kind for inline mode: --kind=<k> wins; else basename heuristic
// ("claude" → claude, "codex" → codex); else error.

export type ParsedRun =
  | { kind: "profile"; profileName: string }
  | { kind: "inline"; agent_kind: "claude" | "codex"; command: string; args: string[] }
  | { kind: "error"; message: string };

function parseKind(v: string): "claude" | "codex" | null {
  return v === "claude" || v === "codex" ? v : null;
}

export function parseRunArgs(argv: string[]): ParsedRun {
  let profileName: string | undefined;
  let kindFlag: "claude" | "codex" | undefined;
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
    break;
  }

  const tail = argv.slice(i);

  if (profileName) {
    if (tail.length > 0) {
      return { kind: "error", message: "cannot combine -p/--profile with a positional command" };
    }
    return { kind: "profile", profileName };
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
  return { kind: "inline", agent_kind, command, args };
}
