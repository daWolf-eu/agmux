import { MANIFEST_POINTS, type ManifestPoint } from "./types.ts";

export { MANIFEST_POINTS };
export type { ManifestPoint };

export function isManifestPoint(s: string): s is ManifestPoint {
  return (MANIFEST_POINTS as readonly string[]).includes(s);
}
