import type { HeadlessContext, HeadlessPlan } from "../../core/types.ts";

// `codex exec <prompt>` is Codex's non-interactive subcommand. The prompt is the
// trailing positional, mirroring claude's `-p`.
export function codexHeadlessPlan(ctx: HeadlessContext): HeadlessPlan {
  return {
    supported: true,
    argv: [ctx.command, "exec", ...ctx.args, ctx.prompt],
    cwd: ctx.cwd,
    env: ctx.env,
  };
}
