import type { TransportSpec } from "@agmux/protocol";
import type { RemoteConfig } from "./config.ts";

export interface Transport {
  spec(target: string): TransportSpec;
  argv(target: string, cmd: string[], o: { tty: boolean }): string[];
}

export function transportArgv(spec: TransportSpec, cmd: string[], o: { tty: boolean }): string[] {
  return [spec.bin, "-g", spec.gateway, "sandbox", "exec", "-n", spec.target, o.tty ? "--tty" : "--no-tty", "--", ...cmd];
}

export function transportControlArgv(spec: TransportSpec, verb: "get" | "start"): string[] {
  const base = [spec.bin, "-g", spec.gateway, "sandbox", verb, spec.target];
  return verb === "get" ? [...base, "-o", "json"] : base;
}

export function openshellTransport(r: RemoteConfig): Transport {
  return {
    spec: (target) => ({ kind: "openshell", gateway: r.gateway, target, bin: r.openshell_bin }),
    argv: (target, cmd, o) => transportArgv({ kind: "openshell", gateway: r.gateway, target, bin: r.openshell_bin }, cmd, o),
  };
}
