import type { ResumeContext, ResumePlan } from "../../core/types.ts";

// `claude --resume <id>` reuses the same session id and replays the conversation
// (spec §1, verified). Without a native id, fall back to a fresh relaunch.
export function claudeResumePlan(ctx: ResumeContext): ResumePlan {
  if (!ctx.nativeSessionId) return { resumable: false };
  return {
    resumable: true,
    argv: [ctx.command, "--resume", ctx.nativeSessionId, ...ctx.args],
    cwd: ctx.cwd,
    env: ctx.env,
    nativeSessionId: ctx.nativeSessionId,
  };
}
