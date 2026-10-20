import type { TransportSpec } from "@agmux/protocol";
import type { RemoteConfig } from "./config.ts";

export interface Transport {
  spec(target: string): TransportSpec;
  argv(target: string, cmd: string[], o: { tty: boolean }): string[];
}

export function openshellTransport(r: RemoteConfig): Transport {
  return {
    spec: (target) => ({ kind: "openshell", gateway: r.gateway, target, bin: r.openshell_bin }),
    argv: (target, cmd, o) => [
      r.openshell_bin, "-g", r.gateway, "sandbox", "exec", "-n", target,
      o.tty ? "--tty" : "--no-tty", "--", ...cmd,
    ],
  };
}
