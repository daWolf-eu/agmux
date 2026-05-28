export type ResolveResult = { ok: true; id: string } | { ok: false; error: string };

export function resolvePrefix(prefix: string, ids: string[]): ResolveResult {
  const matches = ids.filter((id) => id.startsWith(prefix));
  if (matches.length === 1) return { ok: true, id: matches[0]! };
  if (matches.length === 0) return { ok: false, error: `no session matches '${prefix}'` };
  return { ok: false, error: `ambiguous prefix '${prefix}' — ${matches.length} matches` };
}
