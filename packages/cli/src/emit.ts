import * as fs from "node:fs";
import * as path from "node:path";
import {
  stampIngestEvents, buildAttachedEvent, loadRecord,
  type Registry, type CanonicalEvent, type ManifestPoint, type SessionName,
} from "@agmux/adapters";
import type { AgentKind, CapabilitySourceType, IngestEnvelope, SessionMetadataPayload } from "@agmux/protocol";
import { AGMUX_SESSION_ID_ENV, AGMUX_HUB_URL_ENV, tmuxSocketFromEnv } from "@agmux/protocol";
import { resolvePaneCoords, type TmuxExec } from "./tmux-place.ts";
import { probeGit, type GitExec } from "./git-meta.ts";

export interface ParsedEmit {
  from: string;
  source: CapabilitySourceType | null;
  point: ManifestPoint | null;
  attach: boolean;
  profile: string | null;
  cursorFile: string | null;
}

export function parseEmitArgs(argv: string[]): ParsedEmit {
  const get = (k: string): string | null => {
    const hit = argv.find((a) => a.startsWith(`${k}=`));
    return hit ? hit.slice(k.length + 1) : null;
  };
  return {
    from: get("--from") ?? "",
    source: (get("--source") as CapabilitySourceType | null) ?? null,
    point: (get("--point") as ManifestPoint | null) ?? null,
    attach: argv.includes("--attach"),
    profile: get("--profile"),
    cursorFile: get("--cursor-file"),
  };
}

export interface EmitDeps {
  registry: Registry;
  env: Record<string, string | undefined>;
  stdin: string;
  host: string;
  stateDir: string;
  now?: () => string;
  newId?: () => string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  resolveTmux?: TmuxExec;
  git?: GitExec;
  cwd?: () => string;
}

function parseRaw(stdin: string): unknown {
  const s = stdin.trim();
  if (s === "") return {};
  try { return JSON.parse(s); } catch { return { raw: stdin }; }
}

// Resolve the hub endpoint. A wrapper-launched session inherits AGMUX_HUB_URL;
// a NATIVE (ambient) session — claude started directly — does not, so fall back
// to the hub's port file (<stateDir>/hub.port, written by the running hub). With
// neither, return undefined and postOrQueue spools to disk for the next drain.
// Best-effort and silent: a telemetry callback must never throw (spec §4.2).
export function discoverHubUrl(env: Record<string, string | undefined>, stateDir: string): string | undefined {
  const fromEnv = env[AGMUX_HUB_URL_ENV];
  if (fromEnv) return fromEnv;
  try {
    const port = Number(fs.readFileSync(path.join(stateDir, "hub.port"), "utf8").trim());
    if (Number.isInteger(port) && port > 0) return `http://127.0.0.1:${port}`;
  } catch { /* no hub running / unreadable → queue fallback */ }
  return undefined;
}

// Hub URL for a LONG-LIVED subscriber (dash, notifyd), re-read on every poll.
//
// Deliberately the reverse precedence of discoverHubUrl: the live port file
// first, AGMUX_HUB_URL only as a fallback. For a one-shot command the env var is
// a deliberate override and wins; but the wrapper also injects it into every
// agent session (child-env.ts), so a dash popup opened inside an agent pane
// inherits a SNAPSHOT of whatever port the hub had when that session started.
// The hub binds an ephemeral port, so `agmux hub restart` moves it and that
// snapshot goes stale — which showed up as a dash frozen on old rows and a
// status line reading "hub down" moments after a successful restart. The port
// file is authoritative for a local hub; where there is none (a remote hub, or
// no local hub at all) the env var still applies.
export function resolveLiveHubUrl(
  env: Record<string, string | undefined>,
  stateDir: string,
): string | null {
  try {
    const port = Number(fs.readFileSync(path.join(stateDir, "hub.port"), "utf8").trim());
    if (Number.isInteger(port) && port > 0) return `http://127.0.0.1:${port}`;
  } catch { /* no local hub → fall through to the env override */ }
  return env[AGMUX_HUB_URL_ENV] ?? null;
}

// Fill tmux_session/window on session.registered payloads (best effort: fires once
// per registration, never throws, leaves coords null on miss).
export async function enrichTmuxCoords(
  events: Array<{ kind: string; payload: any }>,
  env: Record<string, string | undefined>,
  resolve: (paneId: string) => Promise<{ session: string; window: string } | null>,
): Promise<void> {
  const pane = env.TMUX_PANE;
  if (!pane) return;
  const reg = events.filter((e) => e.kind === "session.registered" && e.payload && e.payload.tmux_session == null);
  if (reg.length === 0) return;
  // Record the server even when session/window resolution fails — a stale pane id
  // on the wrong server is exactly what we are fixing.
  const socket = tmuxSocketFromEnv(env.TMUX);
  for (const e of reg) { e.payload.tmux_socket = socket; }
  const coords = await resolve(pane);
  if (!coords) return;
  for (const e of reg) { e.payload.tmux_session = coords.session; e.payload.tmux_window = coords.window; }
}

// The points at which emit also reports session.metadata: once at registration
// (incl. resume / clear) and after every turn, where a branch switch or a new
// title most likely just happened.
const METADATA_POINTS: readonly ManifestPoint[] = ["session.registered", "turn.ended"];

// Git facts for the hook's cwd (stdin cwd, else the hook process's own — agents
// run hooks in their working directory) plus the adapter's session name.
export async function collectMetadata(
  adapter: { sessionName?: (raw: unknown, env: Record<string, string | undefined>) => SessionName | null },
  raw: unknown, env: Record<string, string | undefined>, cwd: string, git?: GitExec,
): Promise<CanonicalEvent> {
  const stdinCwd = (raw as { cwd?: unknown } | null)?.cwd;
  const dir = typeof stdinCwd === "string" && stdinCwd !== "" ? stdinCwd : cwd;
  const payload: SessionMetadataPayload = { git: await probeGit(dir, git) };
  let name: SessionName | null = null;
  try { name = adapter.sessionName?.(raw, env) ?? null; } catch { /* no name */ }
  if (name) payload.name = name;
  return { kind: "session.metadata", payload };
}

// Stamp hook events with the moment this process was SPAWNED, not the moment
// it got around to stamping. Hooks fire async, one `agmux emit` per hook, and
// cold starts vary by tens of ms — a PreToolUse emit could otherwise be stamped
// after the permission Notification that the agent fired after it, and the
// projection's ordering guard (status_ts) would then believe the wrong one.
// Spawn order is the agent's firing order.
export function hookFiredAt(): string {
  return new Date(performance.timeOrigin).toISOString();
}

// Hot-path contract (spec §4.2): NEVER throws, NEVER writes stdout, drops on
// missing identity, falls back to the per-session queue on any post failure.
export async function runEmit(argv: string[], deps: EmitDeps): Promise<void> {
  try {
    const a = parseEmitArgs(argv);
    if (!a.from) return;
    const adapter = deps.registry.lookup(a.from as AgentKind);
    if (!adapter) return;

    // Identity (spec §2): the agent's OWN native id, plus the optional wrapper bridge
    // claim (AGMUX_SESSION_ID). The native id may live in the hook env (claude) or in
    // hook STDIN (codex) — try env first, then stdin, so ambient (directly-launched)
    // sessions self-register. Native id is preferred; claim is the fallback / bridge.
    // With neither, we cannot name a session — drop.
    const raw = parseRaw(deps.stdin);
    const nativeId = adapter.nativeIdFromEnv?.(deps.env) ?? adapter.nativeIdFromStdin?.(raw) ?? null;
    const claimId = deps.env[AGMUX_SESSION_ID_ENV] ?? null;
    if (!nativeId && !claimId) return;

    let events: CanonicalEvent[];
    if (a.attach) {
      const rec = loadRecord(deps.stateDir, a.from, a.profile);
      if (!rec) return;
      events = [buildAttachedEvent({
        agentKind: a.from as AgentKind, profile: rec.profile,
        adapterVersion: rec.adapterVersion, capabilities: rec.capabilities,
      })];
    } else {
      if (!a.point || !a.source) return;
      const cursor = a.cursorFile && fs.existsSync(a.cursorFile) ? fs.readFileSync(a.cursorFile, "utf8") : null;
      const out = adapter.normalize({
        point: a.point, source: a.source, raw, cursor,
        target: { agentKind: a.from as AgentKind, profile: a.profile },
        env: deps.env,
      });
      events = out.events;
      // Only alongside a real event: an empty normalize means the hook was
      // dropped (nesting guard, a Stop that does not end the turn).
      if (events.length > 0 && METADATA_POINTS.includes(a.point)) {
        events.push(await collectMetadata(adapter, raw, deps.env, (deps.cwd ?? process.cwd)(), deps.git));
      }
      if (a.cursorFile && out.cursor != null) {
        try { fs.writeFileSync(a.cursorFile, out.cursor); } catch { /* best-effort */ }
      }
    }
    if (events.length === 0) return;

    const stamped = stampIngestEvents(events, {
      agentKind: a.from as AgentKind, nativeId, claimId, host: deps.host, now: deps.now ?? hookFiredAt, newId: deps.newId,
    });
    await enrichTmuxCoords(stamped as any, deps.env, (pane) => resolvePaneCoords(pane, deps.resolveTmux, tmuxSocketFromEnv(deps.env.TMUX)));
    await postOrQueue(stamped, {
      hubUrl: discoverHubUrl(deps.env, deps.stateDir), stateDir: deps.stateDir,
      queueKey: nativeId ?? claimId!, // one of the two is set (guard above)
      fetchImpl: deps.fetchImpl ?? fetch, timeoutMs: deps.timeoutMs ?? 1500,
    });
  } catch {
    // Swallow everything: a telemetry failure must never break the agent.
  }
}

async function postOrQueue(events: IngestEnvelope[], o: {
  hubUrl: string | undefined; stateDir: string; queueKey: string;
  fetchImpl: typeof fetch; timeoutMs: number;
}): Promise<void> {
  if (o.hubUrl) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), o.timeoutMs);
      const res = await o.fetchImpl(`${o.hubUrl}/ingest`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(events), signal: ctrl.signal,
      });
      clearTimeout(t);
      if (res.status < 500 && res.status !== 0) return; // 2xx/4xx = delivered or unrecoverable
    } catch { /* fall through to queue */ }
  }
  const queueDir = path.join(o.stateDir, "queue");
  fs.mkdirSync(queueDir, { recursive: true });
  const qf = path.join(queueDir, `${o.queueKey}.jsonl`);
  fs.appendFileSync(qf, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
}
