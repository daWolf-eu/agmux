// Canonical session ids are UUIDv7 (time-ordered). Minted by the wrapper for
// wrapped sessions and by the hub when a native registration has no existing
// session to resolve to (spec §2.3 rule 4). Single source so both paths agree.
export function mintSessionId(): string {
  return Bun.randomUUIDv7();
}

// Ids that came from another host are untrusted and end up in shell and tmux
// command strings (notifier click actions, status-line click ranges). Ingest
// only accepts canonical UUIDs; the sinks additionally keep to these characters.
export const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const EVENT_ID_RE = /^[A-Za-z0-9-]{1,64}$/;

export function isShellSafeId(s: string): boolean {
  return /^[0-9a-f-]+$/i.test(s);
}

export function shellSafeIdChars(s: string): string {
  return s.replace(/[^0-9a-f-]/gi, "");
}
