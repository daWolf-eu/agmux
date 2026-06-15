import type { ResumeContext, ResumePlan } from "../../core/types.ts";

// `codex resume <id>` resumes the recorded session by its UUID (verified against
// Codex 0.135: `codex resume [OPTIONS] [SESSION_ID]`). Note it is a SUBCOMMAND, not
// a flag — that is the one divergence from Claude's `--resume <id>`. Without a
// native id, fall back to a fresh relaunch.
export function codexResumePlan(ctx: ResumeContext): ResumePlan {
  if (!ctx.nativeSessionId) return { resumable: false };
  return {
    resumable: true,
    argv: [ctx.command, "resume", ctx.nativeSessionId, ...ctx.args],
    cwd: ctx.cwd,
    env: ctx.env,
    nativeSessionId: ctx.nativeSessionId,
  };
}
