import { isManifestPoint } from "./manifest.ts";
import type { Adapter, InstallContext, ResumeContext } from "./types.ts";

export interface ConformanceHarness {
  makeContext: () => InstallContext;
  makeResumeContext: (nativeSessionId: string | null) => ResumeContext;
}

// Provider-agnostic STRUCTURAL conformance. Verifies an adapter honors the
// framework contract. It does NOT check normalize() correctness — that needs
// real provider fixtures and is owned by the per-provider test (see the plan's
// Per-Provider Work Packages appendix). Throws on the first violation; returns
// the names of the checks that passed.
export function assertAdapterConformance(adapter: Adapter, h: ConformanceHarness): string[] {
  const passed: string[] = [];
  const ctx = h.makeContext();

  if (!adapter.agentKind) throw new Error("conformance: agentKind missing");
  if (!adapter.adapterVersion) throw new Error("conformance: adapterVersion missing");
  passed.push("identity");

  const sources = adapter.sources(ctx);
  if (!Array.isArray(sources)) throw new Error("conformance: sources() must return an array");
  for (const s of sources) {
    for (const pt of s.points) {
      if (!isManifestPoint(pt)) throw new Error(`conformance: source point '${pt}' is not a manifest point`);
    }
  }
  passed.push("sources");

  const caps = adapter.capabilities(ctx);
  const covered = new Set<string>(sources.flatMap((s) => s.points as string[]));
  for (const [pt, d] of Object.entries(caps)) {
    if (!isManifestPoint(pt)) throw new Error(`conformance: capability key '${pt}' is not a manifest point`);
    if (d.fulfil !== "no" && !covered.has(pt)) {
      throw new Error(`conformance: capability '${pt}' is '${d.fulfil}' but no source covers it`);
    }
  }
  passed.push("capabilities");

  const record = adapter.install(ctx);
  if (record.agentKind !== adapter.agentKind) throw new Error("conformance: record.agentKind mismatch");
  if (adapter.status(ctx).installed !== true) throw new Error("conformance: status not installed after install()");
  adapter.uninstall(ctx, record);
  if (adapter.status(ctx).installed !== false) throw new Error("conformance: status still installed after uninstall()");
  passed.push("install-roundtrip");

  const planNo = adapter.resumePlan(h.makeResumeContext(null));
  if (typeof planNo.resumable !== "boolean") throw new Error("conformance: resumePlan.resumable not boolean");
  const planYes = adapter.resumePlan(h.makeResumeContext("native-123"));
  if (planYes.resumable && (!Array.isArray(planYes.argv) || planYes.argv.length === 0)) {
    throw new Error("conformance: a resumable plan must carry a non-empty argv");
  }
  passed.push("resumePlan");

  return passed;
}
