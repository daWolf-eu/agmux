import type { AgentKind } from "@agmux/protocol";
import type { Adapter } from "./types.ts";

export class Registry {
  private byKind = new Map<AgentKind, Adapter>();

  register(a: Adapter): void {
    if (this.byKind.has(a.agentKind)) {
      throw new Error(`adapter already registered for kind '${a.agentKind}'`);
    }
    this.byKind.set(a.agentKind, a);
  }

  lookup(kind: AgentKind): Adapter | null {
    return this.byKind.get(kind) ?? null;
  }

  kinds(): AgentKind[] {
    return [...this.byKind.keys()];
  }
}

export function createRegistry(): Registry {
  return new Registry();
}
