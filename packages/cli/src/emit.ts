import * as fs from "node:fs";
import * as path from "node:path";
import {
  AGMUX_SESSION_ID_ENV, AGMUX_HUB_URL_ENV,
} from "@agmux/protocol";
import type { AgentKind, CapabilitySourceType, EventEnvelope } from "@agmux/protocol";
import {
  stampEvents, buildAttachedEvent, loadRecord,
  type Registry, type CanonicalEvent, type ManifestPoint,
} from "@agmux/adapters";

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

// Hot-path contract (spec §4.2): NEVER throws, NEVER writes stdout, drops on
// missing identity, falls back to the per-session queue on any post failure.
export async function runEmit(argv: string[], deps: EmitDeps): Promise<void> {
  try {
    const a = parseEmitArgs(argv);
    const sessionId = deps.env[AGMUX_SESSION_ID_ENV];
    if (!sessionId) return; // drop, don't guess (spec §3.3)
    if (!a.from) return;
    const adapter = deps.registry.lookup(a.from as AgentKind);
    if (!adapter) return;

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
      });
      events = out.events;
      if (a.cursorFile && out.cursor != null) {
        try { fs.writeFileSync(a.cursorFile, out.cursor); } catch { /* best-effort */ }
      }
    }
    if (events.length === 0) return;

    const stamped = stampEvents(events, { sessionId, host: deps.host, now: deps.now, newId: deps.newId });
    await postOrQueue(stamped, {
      hubUrl: deps.env[AGMUX_HUB_URL_ENV], stateDir: deps.stateDir, sessionId,
      fetchImpl: deps.fetchImpl ?? fetch, timeoutMs: deps.timeoutMs ?? 1500,
    });
  } catch {
    // Swallow everything: a telemetry failure must never break the agent.
  }
}

async function postOrQueue(events: EventEnvelope[], o: {
  hubUrl: string | undefined; stateDir: string; sessionId: string;
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
  const qf = path.join(queueDir, `${o.sessionId}.jsonl`);
  fs.appendFileSync(qf, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
}
