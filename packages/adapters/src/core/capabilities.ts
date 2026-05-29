import type { AgentKind, CapabilityMap, AdapterAttachedPayload } from "@agmux/protocol";
import type { CanonicalEvent } from "./types.ts";

// Build the per-session capabilities announcement (spec §6.2). Normally fed from
// the install ledger at session start by `agmux emit --attach` (Task 10).
export function buildAttachedEvent(args: {
  agentKind: AgentKind;
  profile: string | null;
  adapterVersion: string;
  capabilities: CapabilityMap;
}): CanonicalEvent {
  const payload: AdapterAttachedPayload = {
    agent_kind: args.agentKind,
    profile: args.profile,
    adapter_version: args.adapterVersion,
    capabilities: args.capabilities,
  };
  return { kind: "session.adapter_attached", payload, dedup_key: null };
}
