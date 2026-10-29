import { sanitizeRemoteText, type TransportSpec } from "@agmux/protocol";
import type { runCapture } from "./discovery.ts";
import { transportControlArgv } from "./transport.ts";

// Sandbox lifecycle seam for the Mac CLI: ask whether a sandbox is up, start it.
// An `ensure()` (create on demand) would plug in here; not built.
export type SandboxStatus = { state: "ready" } | { state: "stopped" } | { state: "missing"; detail: string };

export interface SandboxControl {
  status(spec: TransportSpec): Promise<SandboxStatus>;
  start(spec: TransportSpec): Promise<void>;
}

const GET_TIMEOUT_MS = 10_000;
const START_TIMEOUT_MS = 60_000;

// runCapture rejects with `<bin> exited <code>: <stderr>`: keep stderr's first non-empty line.
function failureDetail(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  const stderr = msg.replace(/^\S+ exited \d+:/, "");
  const line = stderr.split("\n").map((l) => l.trim()).find((l) => l !== "") ?? msg;
  return sanitizeRemoteText(line);
}

export function openshellControl(capture: typeof runCapture): SandboxControl {
  return {
    async status(spec) {
      let out: string;
      try {
        out = await capture(transportControlArgv(spec, "get"), { timeoutMs: GET_TIMEOUT_MS });
      } catch (e) {
        return { state: "missing", detail: failureDetail(e) };
      }
      try {
        // Unparseable output from a successful get is tolerated as ready.
        return (JSON.parse(out) as { phase?: unknown }).phase === "Stopped" ? { state: "stopped" } : { state: "ready" };
      } catch {
        return { state: "ready" };
      }
    },
    async start(spec) {
      await capture(transportControlArgv(spec, "start"), { timeoutMs: START_TIMEOUT_MS });
    },
  };
}
