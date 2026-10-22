import { DEFAULT_REMOTE_MARK, type Locality, type SessionRow } from "@agmux/protocol";

// The dash's client-side locality filter (key `r`): everything, only this
// machine's sessions, or only replicated remote ones.
export type LocalityFilter = "all" | Locality;
export const LOCALITY_CYCLE: LocalityFilter[] = ["all", "local", "remote"];

export function nextLocality(l: LocalityFilter): LocalityFilter {
  return LOCALITY_CYCLE[(LOCALITY_CYCLE.indexOf(l) + 1) % LOCALITY_CYCLE.length]!;
}

// The mark before a remote session (`[ui] remote_mark`, set once by the cli
// before it renders; DEFAULT_REMOTE_MARK otherwise).
let currentRemoteMark = DEFAULT_REMOTE_MARK;
export function remoteMark(): string { return currentRemoteMark; }
export function setRemoteMark(mark: string): void { currentRemoteMark = mark; }

export function matchesLocality(r: SessionRow, l: LocalityFilter): boolean {
  return l === "all" || (l === "remote") === !!r.remote;
}

// "" for local rows; remote rows show where they run: `<mark> <host>` (the part
// after the first "/", i.e. without the transport prefix), `? <host>` when the
// replica is stale.
export function hostLabel(r: SessionRow): string {
  if (!r.remote) return "";
  const i = r.host.indexOf("/");
  const name = i < 0 ? r.host : r.host.slice(i + 1);
  return `${r.sync_stale ? "?" : currentRemoteMark} ${name}`;
}
