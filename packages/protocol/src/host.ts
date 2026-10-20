import * as os from "node:os";
import type { EventEnvelope } from "./events.ts";
import { AGMUX_HOST_ENV } from "./env.ts";

const HOST_NAME_RE = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)?$/;

// `<name>` or `<gateway>/<sandbox>`, at most 255 chars.
export function isValidHostName(s: string): boolean {
  return s.length <= 255 && HOST_NAME_RE.test(s);
}

// The host stamped on events. AGMUX_HOST overrides the OS hostname (remote
// sandboxes identify as `<gateway>/<sandbox>`); an invalid value is ignored.
export function resolveHost(
  env: Record<string, string | undefined> = process.env,
  hostname: string = os.hostname(),
): string {
  const v = env[AGMUX_HOST_ENV];
  return v && isValidHostName(v) ? v : hostname;
}

// Session id carried by host-level events that belong to no session.
export const NO_SESSION_ID = "00000000-0000-0000-0000-000000000000";

export const EVENT_KINDS_HOST = ["host.synced", "host.sync_failed", "host.removed"] as const;
export type HostEventKind = (typeof EVENT_KINDS_HOST)[number];

export interface TransportSpec { kind: "openshell"; gateway: string; target: string; bin: string }

export interface HostSyncedPayload {
  remote: string; transport: TransportSpec; cursor: number; db_id: string;
  agmux_version: string; replication: number; rejected: number;
}
export interface HostSyncFailedPayload { remote: string; error: string }
export interface HostRemovedPayload { remote: string }

export interface HostRow {
  host: string; remote: string; transport: TransportSpec | null;
  last_sync_ts: string | null; last_sync_ok: boolean; last_error: string | null;
  cursor: number; db_id: string | null; agmux_version: string | null;
  replication: number | null; rejected: number; removed_ts: string | null;
}

// In-memory per-[[remote]] sync state of a running hub (GET /hosts `remotes`):
// what `hub status` needs when setup fails before any `hosts` row exists. A
// broken config yields one `{config_error}` entry instead.
export type RemoteSyncState =
  | { config_error: string }
  | { name: string; gateway: string; last_discovery_ts: string | null; last_discovery_error?: string; nodes: number };

export const REPLICATION_VERSION = 1;
// `agmux events --follow --max-duration` ends with this code (EX_TEMPFAIL): the
// follower's planned rotation. Only this code after a valid header respawns at
// once; exit 0 (SIGTERM, e.g. a consumer-lock replacement) is a normal disconnect.
export const EXIT_ROTATE = 75;

// Text that reaches a terminal (session names, branches, cwd, tool details —
// replicated from sandboxes, so untrusted): C0, DEL and C1 controls become a
// space, so no escape sequence or newline survives. Same length, nothing else
// changes; events stay verbatim, this runs at the display sinks.
export function stripControls(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
}

// Remote-supplied text (stderr tails, versions, host names) is untrusted: strip
// control characters (terminal escapes, newlines) and cap the length before it is
// stored or printed.
export function sanitizeRemoteText(s: string, max = 300): string {
  const t = stripControls(s).replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}
export interface ReplicationHeader { replication: number; agmux: string; db_id: string; host: string }
export interface ReplicationRecord { id: number; ev: EventEnvelope }
