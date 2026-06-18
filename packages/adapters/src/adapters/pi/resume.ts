import type { ResumeContext, ResumePlan } from "../../core/types.ts";

// `pi --session <id>` resumes by partial UUID (verified: `pi --session <path|id>`).
// It is a FLAG, not a subcommand — the divergence from codex's `codex resume <id>`
// and the parallel to claude's `--resume <id>`. Without a native id, fall back to
// a fresh relaunch.
export function piResumePlan(ctx: ResumeContext): ResumePlan {
  if (!ctx.nativeSessionId) return { resumable: false };
  return {
    resumable: true,
    argv: [ctx.command, "--session", ctx.nativeSessionId, ...ctx.args],
    cwd: ctx.cwd,
    env: ctx.env,
    nativeSessionId: ctx.nativeSessionId,
  };
}
