import type {
  AgentKind, AdapterEventKind, CapabilityMap, CapabilitySourceType,
} from "@agmux/protocol";

// The fixed, agent-agnostic hook-point vocabulary (spec §3.1). Finest grain so a
// provider can be honest about partial coverage. `session.adapter_attached` is
// NOT here — it is framework-emitted (Task 6), not a provider hook-point.
export const MANIFEST_POINTS = [
  "session.registered",
  "session.linked",
  "turn.started",
  "turn.ended",
  "input.required",
  "input.received",
  "usage.reported",
  "tool.used",
  "prompt.sent",
  "compaction",
] as const;
export type ManifestPoint = (typeof MANIFEST_POINTS)[number];

// v1 ships event-triggered + on-demand only; continuous is reserved (spec §2.0).
export type ActivationMode = "event-triggered" | "continuous" | "on-demand";

// How a per-profile install is physically achieved on a given provider (spec §6.1).
export type IsolationMode = "config-dir" | "env-gated";

// A native surface the adapter wires up; each fulfils one or more manifest points.
export interface CapabilitySource {
  type: CapabilitySourceType;
  activation: ActivationMode;
  points: ManifestPoint[];
}

// The agent-agnostic install/runtime context. Provider-specific paths (config dir)
// and isolationMode are resolved INSIDE the adapter from these fields — core never
// learns provider layout (see "Design decisions locked here", #1).
export interface InstallContext {
  agentKind: AgentKind;
  profile: string | null;            // null = the bare `agent_kind` target
  profileEnv: Record<string, string>; // the env the target launches with (gating, $CODEX_HOME, etc.)
  agmuxEmitPath: string;             // absolute command to bake into hooks, e.g. "/usr/local/bin/agmux emit"
  stateDir: string;                  // ~/.agmux
  configDirOverride?: string | null; // explicit --config-dir from the CLI; the adapter
                                     // interprets it (highest-priority config-dir source)
}

// Everything an adapter needs to compute a native resume invocation (spec §6.4).
export interface ResumeContext {
  agentKind: AgentKind;
  profile: string | null;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  nativeSessionId: string | null;
}

// One reversible thing install() did. `config-key` carries the prior value in
// `restore` so uninstall can put it back; `file` artifacts are deleted.
export interface InstallArtifact {
  kind: "file" | "config-key";
  path: string;
  detail?: string;            // e.g. the config key name
  restore?: string | null;    // prior value for config-key (null = key was absent)
}

export interface InstallRecord {
  agentKind: AgentKind;
  profile: string | null;
  adapterVersion: string;
  isolationMode: IsolationMode;
  capabilities: CapabilityMap;
  artifacts: InstallArtifact[];
}

export interface InstallStatus {
  installed: boolean;
  version: string | null;
  drift: boolean;
  runtimeGate?: "hook-trust" | "none"; // provider trust/enable state (spec §6.2)
  detail?: string;
}

// Opaque resume plan (spec §6.4). resumable=false => caller relaunches fresh.
export interface ResumePlan {
  resumable: boolean;
  argv?: string[];
  cwd?: string;
  env?: Record<string, string>;
  nativeSessionId?: string | null;
}

// A canonical event before identity/envelope stamping. emit stamps these (Task 5).
export interface CanonicalEvent {
  kind: AdapterEventKind;
  payload: unknown;
  dedup_key?: string | null;
}

// Runtime context handed to normalize() (spec §2.1 / §4.1).
export interface NormalizeInput {
  point: ManifestPoint;
  source: CapabilitySourceType;
  raw: unknown;                       // parsed provider payload (from stdin)
  cursor?: string | null;             // per-session source cursor (transcript offset, etc.)
  target: { agentKind: AgentKind; profile: string | null };
  agentVersion?: string | null;
  // The emit process env (inherited from the provider's hook). Lets adapters
  // cross-check identity signals the provider exports (e.g. detect nested runs).
  env?: Record<string, string | undefined>;
}

export interface NormalizeOutput {
  events: CanonicalEvent[];
  cursor?: string | null;             // advanced cursor for cursor-bearing sources
}

// The unified contract every provider module implements (spec §2.1).
export interface Adapter {
  agentKind: AgentKind;
  adapterVersion: string;
  // Env keys this adapter needs restored verbatim at relaunch (spec §6.4) — e.g.
  // the config-dir var that determines where the agent finds its sessions. STRICT
  // allowlist: capture reads ONLY these keys, never the whole environment, so a
  // secret can never be captured by accident. Empty = nothing to restore.
  relaunchEnvKeys: string[];
  sources(ctx: InstallContext): CapabilitySource[];
  capabilities(ctx: InstallContext): CapabilityMap;
  install(ctx: InstallContext): InstallRecord;
  uninstall(ctx: InstallContext, record: InstallRecord): void;
  status(ctx: InstallContext): InstallStatus;
  normalize(input: NormalizeInput): NormalizeOutput;
  resumePlan(ctx: ResumeContext): ResumePlan;
  // Native-first (spec §5): the agent's OWN native id read from its hook/tool env
  // (claude: CLAUDE_CODE_SESSION_ID). Used by `emit` to stamp native identity and
  // by the future spawn path to name a parent. Optional: adapters without a native
  // env signal omit it and fall back to canonical (claim) identity.
  nativeIdFromEnv?(env: Record<string, string | undefined>): string | null;
  // Same purpose as nativeIdFromEnv, but for agents that surface their native id in
  // hook STDIN rather than env (codex: stdin.session_id). `emit` parses stdin once
  // and tries env first, then this — so ambient (directly-launched) sessions can
  // still self-register. `raw` is the parsed stdin JSON (unknown shape).
  nativeIdFromStdin?(raw: unknown): string | null;
}
