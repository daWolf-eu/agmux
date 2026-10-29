import type { LaunchSpec, SessionRow } from "@agmux/protocol";
import { AGMUX_SESSION_ID_ENV, AGMUX_HUB_URL_ENV, AGMUX_LAUNCH_ENV } from "@agmux/protocol";
import type { Registry } from "@agmux/adapters";

export interface RelaunchSpec { wrapArgv: string[]; env: Record<string, string>; }

export interface ProfileLaunch { command: string; args: string[]; env: Record<string, string> }

export interface RelaunchOpts {
  hubUrl: string;
  wrapBin: string;
  registry: Registry;
  baseEnv: Record<string, string | undefined>;
  turnCount?: number; // observed turns (session_usage.turn_count); undefined = unknown
  // Resolve a named profile's env (tilde-expanded). Injected by the CLI so
  // buildRelaunchSpec stays pure/testable. When set and session.profile is
  // non-null, the profile's env is merged OVER captured env_overrides.
  // Ignored when loadProfileLaunch is given (that carries the env too).
  loadProfileEnv?: (name: string) => Record<string, string> | undefined;
  // Resolve a named profile's command/args/env, so a resume replays the
  // profile's args (spec §5.2.1), not only its env.
  loadProfileLaunch?: (name: string) => ProfileLaunch | undefined;
  // Used only when the row has no recorded launch (agent started by hand):
  // e.g. the [[remote]] launch config the Mac passes to a sandbox resume.
  fallbackLaunch?: LaunchSpec;
}

type ResolveOpts = Omit<RelaunchOpts, "wrapBin">;

// What both builders resolve: the launch actually used, the argv to run
// (resume plan argv, or the launch itself), its cwd and the agent's env.
interface ResolvedRelaunch {
  launch: LaunchSpec;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>; // captured env_overrides < profile env < plan env
  resumed: boolean;
}

// A hook-only row (agent not started via agmux) carries the agent kind as its
// command and no args or profile — nothing worth replaying.
function hasRecordedLaunch(s: SessionRow): boolean {
  return s.profile != null || s.args.length > 0 || s.command !== s.agent_kind;
}

// Launch precedence: row profile → row command/args if recorded → fallback
// launch (its profile, else its command/args) → row as today. A profile that
// no longer loads falls through; this never fails.
function pickLaunch(session: SessionRow, opts: ResolveOpts): { launch: LaunchSpec; profileEnv: Record<string, string> } {
  const fromProfile = (name: string | null) => {
    const p = name && opts.loadProfileLaunch ? opts.loadProfileLaunch(name) : undefined;
    return p && name ? { launch: { profile: name, command: p.command, args: p.args }, profileEnv: p.env } : undefined;
  };
  const rowLaunch = { profile: null, command: session.command, args: session.args };
  const fallback = opts.fallbackLaunch;

  const picked = fromProfile(session.profile);
  if (picked) return picked;
  // Legacy env-only loader: the row's own command/args, profile env on top.
  const legacyEnv = session.profile && !opts.loadProfileLaunch && opts.loadProfileEnv
    ? (opts.loadProfileEnv(session.profile) ?? {}) : {};
  if (hasRecordedLaunch(session) || !fallback) return { launch: rowLaunch, profileEnv: legacyEnv };
  return fromProfile(fallback.profile)
    ?? { launch: { profile: null, command: fallback.command, args: fallback.args }, profileEnv: {} };
}

function resolveRelaunch(session: SessionRow, opts: ResolveOpts): ResolvedRelaunch {
  const { launch, profileEnv } = pickLaunch(session, opts);
  // Precedence: captured env_overrides < profile env (B wins). The merged env
  // becomes the resume plan's env and the agent's env.
  const sessionEnv: Record<string, string> = { ...(session.env_overrides ?? {}), ...profileEnv };
  const out: ResolvedRelaunch = {
    launch, command: launch.command, args: launch.args, cwd: session.cwd, env: sessionEnv, resumed: false,
  };

  // A session with zero observed turns never persisted a native conversation
  // (e.g. Claude drops empty sessions), so a native resume is guaranteed to fail
  // ("No conversation found"). Relaunch fresh instead. Unknown (undefined) keeps
  // the resume attempt — adapters may track sessions we didn't see turns for.
  const neverConversed = opts.turnCount === 0;

  const adapter = opts.registry.lookup(session.agent_kind);
  if (adapter && session.native_session_id && !neverConversed) {
    const plan = adapter.resumePlan({
      agentKind: session.agent_kind, profile: session.profile,
      command: launch.command, args: launch.args, cwd: session.cwd,
      env: sessionEnv, nativeSessionId: session.native_session_id,
    });
    if (plan.resumable && plan.argv && plan.argv.length > 0) {
      out.command = plan.argv[0]!;
      out.args = plan.argv.slice(1);
      if (plan.cwd) out.cwd = plan.cwd;
      // plan.env merges last. For claude it equals the sessionEnv we passed in
      // (profile-wins precedence already applied), so this is a no-op. An adapter that
      // injects its OWN env in resumePlan would override profile env here — revisit the
      // ordering if that ever happens.
      if (plan.env) out.env = { ...out.env, ...plan.env };
      out.resumed = true;
    }
  }
  return out;
}

function definedEnv(base: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined) env[k] = v;
  return env;
}

// Build the relaunch (command + env) for a dead/lost session. If the adapter can
// natively resume (spec §6.4) and we have a native_session_id, rewrite the inline
// profile to the resume argv; otherwise reproduce today's MVP relaunch.
export function buildRelaunchSpec(session: SessionRow, opts: RelaunchOpts): RelaunchSpec {
  const env = definedEnv(opts.baseEnv);
  env[AGMUX_SESSION_ID_ENV] = session.session_id;
  env[AGMUX_HUB_URL_ENV] = opts.hubUrl;

  const r = resolveRelaunch(session, opts);

  // Unchanged + profile-backed → let the wrapper reload from config by name.
  if (!r.resumed && session.profile) {
    return { wrapArgv: [opts.wrapBin, session.profile], env };
  }

  const inlineProfile = { agent_kind: session.agent_kind, command: r.command, args: r.args, env: r.env, cwd: r.cwd };
  env.AGMUX_INLINE_PROFILE = JSON.stringify(inlineProfile);
  return { wrapArgv: [opts.wrapBin, r.command.split("/").pop() ?? "agent"], env };
}

export interface DirectRelaunch { argv: string[]; env: Record<string, string>; cwd: string | undefined; launch: LaunchSpec }

// The same resolution without the wrapper, for a sandbox resume (spec §5.2.1).
// No AGMUX_SESSION_ID: the resumed agent's hooks re-register by native id
// (rule 1 in store/src/resolve.ts); AGMUX_LAUNCH records the launch used.
export function buildDirectRelaunch(
  session: SessionRow,
  opts: ResolveOpts & { agmuxBin: string },
): DirectRelaunch {
  const r = resolveRelaunch(session, opts);
  const env = { ...definedEnv(opts.baseEnv), ...r.env };
  delete env[AGMUX_SESSION_ID_ENV];
  env[AGMUX_HUB_URL_ENV] = opts.hubUrl;
  env.AGMUX_BIN = opts.agmuxBin;
  env[AGMUX_LAUNCH_ENV] = JSON.stringify(r.launch);
  return { argv: [r.command, ...r.args], env, cwd: r.cwd, launch: r.launch };
}
