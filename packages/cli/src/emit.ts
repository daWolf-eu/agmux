import * as fs from "node:fs";
import * as path from "node:path";
import {
  stampIngestEvents, buildAttachedEvent, loadRecord,
  type Registry, type CanonicalEvent, type ManifestPoint,
} from "@agmux/adapters";
import type { AgentKind, CapabilitySourceType, IngestEnvelope } from "@agmux/protocol";
import { AGMUX_SESSION_ID_ENV, AGMUX_HUB_URL_ENV } from "@agmux/protocol";

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
function discoverHubUrl(env: Record<string, string | undefined>, stateDir: string): string | undefined {
  const fromEnv = env[AGMUX_HUB_URL_ENV];
  if (fromEnv) return fromEnv;
  try {
    const port = Number(fs.readFileSync(path.join(stateDir, "hub.port"), "utf8").trim());
    if (Number.isInteger(port) && port > 0) return `http://127.0.0.1:${port}`;
  } catch { /* no hub running / unreadable → queue fallback */ }
  return undefined;
}

// Hot-path contract (spec §4.2): NEVER throws, NEVER writes stdout, drops on
// missing identity, falls back to the per-session queue on any post failure.
export async function runEmit(argv: string[], deps: EmitDeps): Promise<void> {
  try {
    const a = parseEmitArgs(argv);
    if (!a.from) return;
    const adapter = deps.registry.lookup(a.from as AgentKind);
    if (!adapter) return;

    // Identity (spec §2): the agent's OWN native id (from its hook env), plus the
    // optional wrapper bridge claim (AGMUX_SESSION_ID). Native id is preferred;
    // claim is the fallback / bridge. With neither, we cannot name a session — drop.
    const nativeId = adapter.nativeIdFromEnv?.(deps.env) ?? null;
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
        point: a.point, source: a.source, raw: parseRaw(deps.stdin), cursor,
        target: { agentKind: a.from as AgentKind, profile: a.profile },
        env: deps.env,
      });
      events = out.events;
      if (a.cursorFile && out.cursor != null) {
        try { fs.writeFileSync(a.cursorFile, out.cursor); } catch { /* best-effort */ }
      }
    }
    if (events.length === 0) return;

    const stamped = stampIngestEvents(events, {
      agentKind: a.from as AgentKind, nativeId, claimId, host: deps.host, now: deps.now, newId: deps.newId,
    });
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
