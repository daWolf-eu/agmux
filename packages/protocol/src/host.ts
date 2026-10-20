import * as os from "node:os";
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
