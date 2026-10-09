// `agmux attach <id> --placement <p>`: the dash's placement executor on the CLI.
// Lives apart from attach.ts because dash-actions.ts already imports attach.ts.
import type { AttachPlacement, SessionRow } from "@agmux/protocol";
import { attachKind, type Handoff } from "@agmux/tui";
import { makeActions } from "./dash-actions.ts";
import { resolvePrefix } from "./id-resolve.ts";
import { postSeen } from "./seen.ts";
import type { AttachSettings } from "./attach-place.ts";

export interface AttachPlacedOpts {
  idOrPrefix: string; hubUrl: string; wrapBin: string; placement: AttachPlacement; settings: AttachSettings;
}

export interface AttachPlacedDeps {
  makeActionsImpl?: typeof makeActions;
  spawn?: (h: Handoff) => Promise<number>;
  err?: (s: string) => void;
}

async function spawnForeground(h: Handoff): Promise<number> {
  const child = Bun.spawn(h.argv, { stdio: ["inherit", "inherit", "inherit"], env: h.env ?? process.env });
  await child.exited;
  return child.exitCode ?? 0;
}

export async function attachPlacedCmd(opts: AttachPlacedOpts, deps: AttachPlacedDeps = {}): Promise<number> {
  const err = deps.err ?? ((s: string) => console.error(s));
  const listR = await fetch(`${opts.hubUrl}/sessions?all=1&limit=1000`);
  if (!listR.ok) { err(`hub error ${listR.status}`); return 1; }
  const { sessions } = (await listR.json()) as { sessions: SessionRow[] };
  const res = resolvePrefix(opts.idOrPrefix, sessions.map((s) => s.session_id));
  if (!res.ok) { err(res.error); return 2; }
  const { session } = (await (await fetch(`${opts.hubUrl}/sessions/${res.id}`)).json()) as { session: SessionRow };

  const kind = attachKind(session);
  if (kind === "none") { err("attach: session has no tmux pane"); return 1; }

  // Same bookkeeping as plain `agmux attach`: opening a session marks it seen.
  void postSeen(session.session_id, "attach", {
    hubUrl: opts.hubUrl, host: session.host,
    fetchImpl: fetch, now: () => new Date().toISOString(), newId: () => crypto.randomUUID(),
  }).catch(() => {});

  const actions = (deps.makeActionsImpl ?? makeActions)(opts.hubUrl, opts.wrapBin, false, undefined, opts.settings);
  const req = { placement: opts.placement };
  let h: Handoff | null;
  try {
    h = kind === "closed" ? await actions.resume(session, req) : await actions.attach(session, req);
  } catch (e) {
    err(`attach: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  return h && h.argv.length > 0 ? (deps.spawn ?? spawnForeground)(h) : 0;
}
