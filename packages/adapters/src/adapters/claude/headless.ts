import type { HeadlessContext, HeadlessPlan } from "../../core/types.ts";

// `claude -p <prompt>` runs one non-interactive turn and prints the reply to
// stdout (verified: hooks still fire, CLAUDE_CODE_SESSION_ID is exported, and the
// transcript is written — so the run is recorded and natively resumable).
export function claudeHeadlessPlan(ctx: HeadlessContext): HeadlessPlan {
  return {
    supported: true,
    argv: [ctx.command, ...ctx.args, "-p", ctx.prompt],
    cwd: ctx.cwd,
    env: ctx.env,
  };
}
