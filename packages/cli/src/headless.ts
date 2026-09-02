import * as os from "node:os";
import * as path from "node:path";
import type { Registry, HeadlessPlan } from "@agmux/adapters";
import { AGMUX_SESSION_ID_ENV, AGMUX_HUB_URL_ENV, AGMUX_PROFILE_ENV } from "@agmux/protocol";
import {
  HubClient, mintSessionId, buildStartedEvent, buildEndedEvent, type ProfileConfig,
} from "@agmux/wrapper";

// A headless run inherits the caller's environment, which — when the caller sits
// inside tmux — carries $TMUX and $TMUX_PANE pointing at THEIR pane. The agent's
// own hooks call `agmux emit`, whose enrichTmuxCoords would then stamp the
// caller's live pane onto a session that has no pane at all, and dash would offer
// to attach to an unrelated window. Strip them: a headless session is honestly
// pane-less, and the started event below records null coords to match.
export function scrubTmuxEnv(base: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (k === "TMUX" || k === "TMUX_PANE") continue;
    out[k] = v;
  }
  return out;
}

export interface HeadlessOpts {
  profile: ProfileConfig;
  profileName: string | null;
  prompt: string;
  hubUrl: string;
  stateDir: string;
  registry: Registry;
  baseEnv?: Record<string, string | undefined>;
}

export interface HeadlessResult {
  exitCode: number;
  sessionId: string | null;   // null when we never got as far as a session
  error?: string;
}

export function planFor(o: HeadlessOpts, cwd: string, env: Record<string, string>): HeadlessPlan {
  const adapter = o.registry.lookup(o.profile.agent_kind);
  if (!adapter?.headlessPlan) return { supported: false };
  return adapter.headlessPlan({
    agentKind: o.profile.agent_kind,
    profile: o.profileName,
    command: o.profile.command,
    args: o.profile.args,
    cwd, env, prompt: o.prompt,
  });
}

// Run one non-interactive turn: no tmux, no PTY, stdout streamed straight through
// so `agmux run -p X --headless "..." > out.md` behaves like any other command.
// Every agmux-authored line goes to stderr to keep stdout clean for piping.
export async function runHeadless(o: HeadlessOpts): Promise<HeadlessResult> {
  const base = o.baseEnv ?? process.env;
  const cwd = o.profile.cwd ?? process.cwd();
  const sessionId = mintSessionId();
  const host = os.hostname();

  const env = scrubTmuxEnv(base);
  Object.assign(env, o.profile.env);
  // The claim bridge: resolveIngest adopts AGMUX_SESSION_ID only when a live row
  // with that id and a null native id already exists — hence the started event
  // below MUST be posted before the agent boots and its hooks self-register.
  env[AGMUX_SESSION_ID_ENV] = sessionId;
  env[AGMUX_HUB_URL_ENV] = o.hubUrl;
  if (o.profileName) env[AGMUX_PROFILE_ENV] = o.profileName;

  const plan = planFor(o, cwd, env);
  if (!plan.supported || !plan.argv || plan.argv.length === 0) {
    return {
      exitCode: 2, sessionId: null,
      error: `agent kind '${o.profile.agent_kind}' has no headless mode`,
    };
  }

  const client = new HubClient({
    hubUrl: o.hubUrl, queueDir: path.join(o.stateDir, "queue"), sessionId,
  });

  const child = Bun.spawn(plan.argv, {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    cwd: plan.cwd ?? cwd,
    env: plan.env ?? env,
  });

  await client.post(buildStartedEvent({
    sessionId, host,
    agent_kind: o.profile.agent_kind, profile: o.profileName,
    command: o.profile.command, args: o.profile.args, env_overrides: o.profile.env,
    cwd, pid: child.pid!,
    // Pane-less by construction — see scrubTmuxEnv.
    tmux: { session: null, window: null, pane: null, socket: null },
    project: null,
  }));

  // No heartbeat: a headless run is bounded and always posts session.ended, so
  // there is no liveness gap for the reaper to fill.
  const exitCode = (await child.exited) ?? 0;
  const signal = child.signalCode ?? null;

  await client.post(buildEndedEvent({ sessionId, host, exitCode, signal }));

  return { exitCode, sessionId };
}
