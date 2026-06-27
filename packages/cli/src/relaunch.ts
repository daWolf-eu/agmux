import type { SessionRow } from "@agmux/protocol";
import { AGMUX_SESSION_ID_ENV, AGMUX_HUB_URL_ENV } from "@agmux/protocol";
import type { Registry } from "@agmux/adapters";

export interface RelaunchSpec { wrapArgv: string[]; env: Record<string, string>; }

export interface RelaunchOpts {
  hubUrl: string;
  wrapBin: string;
  registry: Registry;
  baseEnv: Record<string, string | undefined>;
  turnCount?: number; // observed turns (session_usage.turn_count); undefined = unknown
  // Resolve a named profile's env (tilde-expanded). Injected by the CLI so
  // buildRelaunchSpec stays pure/testable. When set and session.profile is
  // non-null, the profile's env is merged OVER captured env_overrides.
  loadProfileEnv?: (name: string) => Record<string, string> | undefined;
}

// Build the relaunch (command + env) for a dead/lost session. If the adapter can
// natively resume (spec §6.4) and we have a native_session_id, rewrite the inline
// profile to the resume argv; otherwise reproduce today's MVP relaunch.
export function buildRelaunchSpec(session: SessionRow, opts: RelaunchOpts): RelaunchSpec {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.baseEnv)) if (v !== undefined) env[k] = v;
  env[AGMUX_SESSION_ID_ENV] = session.session_id;
  env[AGMUX_HUB_URL_ENV] = opts.hubUrl;

  let command = session.command;
  let args = session.args;
  let cwd = session.cwd;
  // Precedence: captured env_overrides < profile env (B wins). The merged env
  // becomes the resume plan's env and the inline profile's env.
  const capturedEnv = session.env_overrides ?? {};
  const profileEnv = session.profile && opts.loadProfileEnv ? (opts.loadProfileEnv(session.profile) ?? {}) : {};
  const sessionEnv: Record<string, string> = { ...capturedEnv, ...profileEnv };
  let extraEnv: Record<string, string> = sessionEnv;
  let resumed = false;

  // A session with zero observed turns never persisted a native conversation
  // (e.g. Claude drops empty sessions), so a native resume is guaranteed to fail
  // ("No conversation found"). Relaunch fresh instead. Unknown (undefined) keeps
  // the resume attempt — adapters may track sessions we didn't see turns for.
  const neverConversed = opts.turnCount === 0;

  const adapter = opts.registry.lookup(session.agent_kind);
  if (adapter && session.native_session_id && !neverConversed) {
    const plan = adapter.resumePlan({
      agentKind: session.agent_kind, profile: session.profile,
      command: session.command, args: session.args, cwd: session.cwd,
      env: sessionEnv, nativeSessionId: session.native_session_id,
    });
    if (plan.resumable && plan.argv && plan.argv.length > 0) {
      command = plan.argv[0]!;
      args = plan.argv.slice(1);
      if (plan.cwd) cwd = plan.cwd;
      // plan.env merges last. For claude it equals the sessionEnv we passed in
      // (profile-wins precedence already applied), so this is a no-op. An adapter that
      // injects its OWN env in resumePlan would override profile env here — revisit the
      // ordering if that ever happens.
      if (plan.env) extraEnv = { ...extraEnv, ...plan.env };
      resumed = true;
    }
  }

  // Unchanged + profile-backed → let the wrapper reload from config by name.
  if (!resumed && session.profile) {
    return { wrapArgv: [opts.wrapBin, session.profile], env };
  }

  const inlineProfile = { agent_kind: session.agent_kind, command, args, env: extraEnv, cwd };
  env.AGMUX_INLINE_PROFILE = JSON.stringify(inlineProfile);
  return { wrapArgv: [opts.wrapBin, command.split("/").pop() ?? "agent"], env };
}
