import * as fs from "node:fs";
import * as path from "node:path";
import type {
  Adapter, InstallContext, InstallRecord, InstallStatus,
  NormalizeInput, NormalizeOutput, ResumeContext, ResumePlan, CapabilitySource,
} from "../../src/core/types.ts";
import type { CapabilityMap } from "@agmux/protocol";

function configDir(ctx: InstallContext): string {
  return ctx.profileEnv.FAKE_CONFIG_DIR ?? path.join(ctx.stateDir, "fake", ctx.profile ?? "_bare");
}
function markerFile(ctx: InstallContext): string {
  return path.join(configDir(ctx), "agmux-fake.json");
}

const CAPS: CapabilityMap = {
  "turn.started": { fulfil: "yes", source: "hook-command", liveness: "live" },
  "turn.ended": { fulfil: "yes", source: "hook-command", liveness: "live" },
  "input.required": { fulfil: "yes", source: "hook-command", liveness: "live" },
  "input.received": { fulfil: "yes", source: "hook-command", liveness: "live" },
  "session.linked": { fulfil: "yes", source: "transcript-delta", liveness: "backfilled" },
  "usage.reported": { fulfil: "partial", source: "transcript-delta", liveness: "backfilled" },
};

export const fakeAdapter: Adapter = {
  agentKind: "claude",
  adapterVersion: "1",

  sources(_ctx): CapabilitySource[] {
    return [
      { type: "hook-command", activation: "event-triggered", points: ["turn.started", "turn.ended", "input.required", "input.received"] },
      { type: "transcript-delta", activation: "event-triggered", points: ["session.linked", "usage.reported"] },
    ];
  },

  capabilities(_ctx): CapabilityMap {
    return CAPS;
  },

  install(ctx): InstallRecord {
    const file = markerFile(ctx);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ emit: ctx.agmuxEmitPath }));
    return {
      agentKind: "claude", profile: ctx.profile, adapterVersion: "1",
      isolationMode: "config-dir", capabilities: CAPS,
      artifacts: [{ kind: "file", path: file }],
    };
  },

  uninstall(_ctx, record): void {
    for (const a of record.artifacts) if (a.kind === "file") fs.rmSync(a.path, { force: true });
  },

  status(ctx): InstallStatus {
    const installed = fs.existsSync(markerFile(ctx));
    return { installed, version: installed ? "1" : null, drift: false, runtimeGate: "none" };
  },

  normalize(input: NormalizeInput): NormalizeOutput {
    if (input.point === "turn.started") {
      return { events: [{ kind: "turn.started", payload: { turn_id: (input.raw as any)?.turn_id ?? null } }] };
    }
    if (input.point === "usage.reported") {
      const offset = (input.raw as any)?.offset ?? 0;
      return {
        events: [{
          kind: "usage.reported",
          payload: { cumulative: false, source: "transcript-delta", input_tokens: (input.raw as any)?.input_tokens ?? 0 },
          dedup_key: `transcript-delta:${input.target.agentKind}:${offset}`,
        }],
        cursor: String(offset + 1),
      };
    }
    return { events: [] };
  },

  resumePlan(ctx: ResumeContext): ResumePlan {
    if (!ctx.nativeSessionId) return { resumable: false };
    return {
      resumable: true,
      argv: ["fake-cli", "resume", ctx.nativeSessionId],
      cwd: ctx.cwd,
      env: ctx.env,
      nativeSessionId: ctx.nativeSessionId,
    };
  },

  nativeIdFromEnv(env): string | null {
    return env.FAKE_NATIVE_ID ?? null;
  },
};
