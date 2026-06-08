// Canonical session ids are UUIDv7 (time-ordered). Minted by the wrapper for
// wrapped sessions and by the hub when a native registration has no existing
// session to resolve to (spec §2.3 rule 4). Single source so both paths agree.
export function mintSessionId(): string {
  return Bun.randomUUIDv7();
}
