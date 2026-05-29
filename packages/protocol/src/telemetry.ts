// Wire types shared between the store/hub (Phase 1) and the adapters package
// (Phase 2). Kept in @agmux/protocol because they appear in event payloads
// (usage.reported, session.adapter_attached) that cross the ingest boundary.

export type CapabilitySourceType =
  | "hook-command"
  | "transcript-delta"
  | "exec-json-stream"
  | "transcript-tail"
  | "mcp"
  | "manual-command";

export type CapabilityFulfilment = "yes" | "partial" | "no";

export interface CapabilityDescriptor {
  fulfil: CapabilityFulfilment;
  source?: CapabilitySourceType;
  liveness?: "live" | "backfilled";
  minAgentVersion?: string;
  runtimeGate?: "hook-trust" | "none";
}

// Keyed by hook-point name at its finest grain (e.g. "turn.started",
// "input.permission"). A missing key means "not declared" == not fulfilled.
export type CapabilityMap = Record<string, CapabilityDescriptor>;

// Normalized usage. Every figure nullable; an adapter fills what its provider
// exposes. Superset of common first-party fields so normalization never erases
// data a provider already gives us. Additive over time (all nullable).
export interface UsageReport {
  model?: string | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  reasoning_output_tokens?: number | null;
  total_tokens?: number | null;
  cache_read_tokens?: number | null;
  cache_write_tokens?: number | null;
  model_context_window?: number | null;
  rate_limit?: unknown;          // provider-shaped; stored as JSON
  cost_usd?: number | null;
  turn_id?: string | null;
  cumulative: boolean;           // false = per-turn delta, true = session total
  as_of?: string | null;         // provider timestamp the figures are valid at
  source: string;                // which CapabilitySource produced this
}
