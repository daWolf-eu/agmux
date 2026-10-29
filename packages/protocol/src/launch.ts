// How agmux launched an agent, handed to the hooks via AGMUX_LAUNCH so a
// registration can record it and a later resume reuses the same argv.
export interface LaunchSpec { profile: string | null; command: string; args: string[] }

export function parseLaunchSpec(s: string | undefined): LaunchSpec | null {
  if (!s) return null;
  let v: unknown;
  try { v = JSON.parse(s); } catch { return null; }
  if (typeof v !== "object" || v === null) return null;
  const { profile, command, args } = v as Record<string, unknown>;
  if (typeof command !== "string" || command === "") return null;
  if (!Array.isArray(args) || !args.every((a) => typeof a === "string")) return null;
  if (profile !== null && typeof profile !== "string") return null;
  return { profile, command, args: args as string[] };
}
