import { AGMUX_HUB_URL_ENV } from "@agmux/protocol";

// Profile mode → wrapper loads the named profile from ~/.config/agmux/config.toml.
export interface RunProfileOpts {
  kind: "profile";
  profileName: string;
  hubUrl: string;
  wrapBin: string;
}

// Ad-hoc mode → CLI builds an inline-profile spec and passes it via env. Wrapper
// reads AGMUX_INLINE_PROFILE and skips the config-file lookup.
export interface RunInlineOpts {
  kind: "inline";
  agent_kind: "claude" | "codex";
  command: string;
  args: string[];
  hubUrl: string;
  wrapBin: string;
}

export type RunOpts = RunProfileOpts | RunInlineOpts;

export async function runCmd(opts: RunOpts): Promise<number> {
  if (opts.kind === "profile") {
    const child = Bun.spawn([opts.wrapBin, opts.profileName], {
      stdio: ["inherit", "inherit", "inherit"],
      env: { ...process.env, [AGMUX_HUB_URL_ENV]: opts.hubUrl },
    });
    await child.exited;
    return child.exitCode ?? 0;
  }

  // Inline mode: synthesize a ProfileConfig-shaped JSON for the wrapper.
  const inlineProfile = {
    agent_kind: opts.agent_kind,
    command: opts.command,
    args: opts.args,
    env: {},
  };
  // Argv passed to the wrapper is just a label; the wrapper sees the inline env
  // var first and uses that. We pass a basename for readable tmux window names.
  const label = opts.command.split("/").pop() ?? "agent";
  const child = Bun.spawn([opts.wrapBin, label], {
    stdio: ["inherit", "inherit", "inherit"],
    env: {
      ...process.env,
      [AGMUX_HUB_URL_ENV]: opts.hubUrl,
      AGMUX_INLINE_PROFILE: JSON.stringify(inlineProfile),
    },
  });
  await child.exited;
  return child.exitCode ?? 0;
}
