// Mac side of resuming a closed remote (sandbox) session (spec §5.2): the
// sandbox's own agmux resumes its row next to where it ran
// (`attach <id> --resume-nearest --print-coords`), then the Mac waits for the
// replicated row and opens it with the Phase 2 remote attach. Every value
// reaches the sandbox as its own argv element; nothing is shell-joined.
import {
  AGMUX_VERSION, LIVE_STATUSES, isShellSafeId, sanitizeRemoteText, stripControls,
  type LaunchSpec, type RemoteTmux, type SessionRow,
} from "@agmux/protocol";
import { openshellControl, runCapture, transportArgv, type RemoteConfig, type SandboxControl } from "@agmux/hub";
import { attachKind, resolvePlacement, type AttachCtx, type AttachRequest, type Handoff } from "@agmux/tui";
import type { AttachSettings } from "./attach-place.ts";
import { attachRemote, defaultAttachRemoteDeps } from "./attach-remote.ts";
import { SANDBOX_NAME_RE } from "./parse-run.ts";
import {
  WAIT_POLL_MS, WAIT_TIMEOUT_MS, execCapture, fetchHostRow, kickFollower, matchesPrinted,
  message, oldAgmux, printedCoords, unfollowed, versionSkew, waitForRemoteRow, type SandboxExecResult,
} from "./run-remote.ts";

export interface ResumeRemoteDeps {
  fetchImpl: typeof fetch;
  control: SandboxControl;
  exec: (argv: string[]) => Promise<SandboxExecResult>;  // stdin ignored, output captured
  attachRemote: (row: SessionRow, req: AttachRequest | undefined, env: { ctx: AttachCtx; settings: AttachSettings }) => Promise<Handoff | null>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export const defaultResumeRemoteDeps: ResumeRemoteDeps = {
  fetchImpl: fetch,
  control: openshellControl(runCapture),
  exec: execCapture,
  attachRemote: (row, req, env) => attachRemote(row, req, env, defaultAttachRemoteDeps),
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

// The launch a row without a recorded one is resumed with: the remote's
// [[remote]] launch (R5). None configured → the sandbox relaunches the row as is.
export function fallbackLaunch(remote: RemoteConfig | undefined, row: Pick<SessionRow, "agent_kind">): LaunchSpec | null {
  const l = remote?.launch;
  if (!l) return null;
  return { profile: l.profile, command: l.command ?? l.kind ?? row.agent_kind, args: l.args };
}

// The sandbox-side resume (contract: attach --resume-nearest --print-coords, Task 6).
export function sandboxResumeArgv(agmuxBin: string, sessionId: string, fallback: LaunchSpec | null): string[] {
  return [
    agmuxBin, "attach", sessionId, "--resume-nearest", "--print-coords",
    ...(fallback ? ["--fallback-launch", JSON.stringify(fallback)] : []),
  ];
}

// A row without a native id is relaunched fresh under a NEW session id (R4):
// the wait matches the printed coords, not the id. The old row keeps its old
// coords until the resume replicates; requiring a live row skips it.
function resumedRow(printed: RemoteTmux): (r: SessionRow) => boolean {
  const at = matchesPrinted(printed);
  return (r) => attachKind(r) === "remote" && at(r);
}

export async function resumeRemote(
  row: SessionRow,
  req: AttachRequest | undefined,
  env: { ctx: AttachCtx; settings: AttachSettings; hubUrl: string; remotes: () => RemoteConfig[] },
  deps: ResumeRemoteDeps,
): Promise<Handoff | null> {
  const { ctx, settings, hubUrl } = env;
  const host = row.host;
  const id = row.session_id;
  if (!isShellSafeId(id)) throw new Error("resume: invalid session id");
  // A live row without tmux coords (headless) is still running: a resume would start it twice.
  if (LIVE_STATUSES.includes(row.status)) throw new Error(stripControls(`resume: ${id.slice(0, 8)} is still running on ${host}; nothing to resume`));
  // Check the local placement before anything starts in the sandbox.
  try { resolvePlacement("remote", ctx, req?.placement, { remote: settings.remote.placement }); }
  catch (e) { throw new Error(`resume: ${message(e)}`); }

  const gone = () => new Error(`resume: sandbox ${host} is gone; cannot resume`);
  let hostRow;
  try { hostRow = await fetchHostRow(hubUrl, deps.fetchImpl, host); }
  catch (e) { throw new Error(`resume: ${message(e)}`); }
  const spec = hostRow?.transport;
  if (!hostRow || hostRow.removed_ts != null || !spec) throw gone();
  if (!SANDBOX_NAME_RE.test(spec.target)) throw new Error(`resume: ${host}: invalid sandbox name`);

  let remote: RemoteConfig | undefined;
  try { remote = env.remotes().find((r) => r.name === hostRow.remote); }
  catch (e) { throw new Error(`resume: ${message(e)}`); }

  // Order: status → version → start → exec, so a refused version never leaves a sandbox started.
  const status = await deps.control.status(spec);
  if (status.state === "missing") {
    const detail = sanitizeRemoteText(status.detail);
    throw new Error(detail ? `${gone().message}\nagmux: ${detail}` : gone().message);
  }
  // After status: a deleted sandbox's stale host row must not report a version skew.
  if (hostRow.agmux_version != null && hostRow.agmux_version !== AGMUX_VERSION) throw new Error(versionSkew(host, hostRow.agmux_version));
  if (status.state === "stopped") {
    try { await deps.control.start(spec); }
    catch (e) { throw new Error(`resume: cannot start sandbox ${host}: ${sanitizeRemoteText(message(e))}`); }
  }

  const cmd = sandboxResumeArgv(remote?.agmux_bin ?? "agmux", id, fallbackLaunch(remote, row));
  const res = await deps.exec(transportArgv(spec, cmd, { tty: false }));
  const stderr = sanitizeRemoteText(res.stderr);
  if (res.code !== 0) throw new Error(`resume: ${host}: ${stderr || `exited ${res.code}`}`);
  const printed = printedCoords(res.stdout);
  // An agmux without --resume-nearest ignores the flags and runs a plain attach
  // (exit 0, nothing printed); a current one always prints coords on success.
  if (!printed) throw new Error(oldAgmux(host));

  if (await kickFollower(hubUrl, deps.fetchImpl, host) === "unfollowed") throw new Error(`resume: started in ${host}, but ${unfollowed(host)}`);
  const resumed = await waitForRemoteRow({
    hubUrl, fetchImpl: deps.fetchImpl, host, match: resumedRow(printed),
    timeoutMs: WAIT_TIMEOUT_MS, pollMs: WAIT_POLL_MS, now: deps.now, sleep: deps.sleep,
  });
  if (!resumed) throw new Error(`resume: started in ${host}, but the session has not replicated yet; run agmux ls --host ${host}`);

  try { return await deps.attachRemote(resumed, req, { ctx, settings }); }
  catch (e) { throw new Error(`resume: ${message(e)}`); }
}
