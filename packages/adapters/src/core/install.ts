import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentKind } from "@agmux/protocol";
import type { Adapter, InstallContext, InstallRecord } from "./types.ts";

// Per-target ledger path (spec §6.3): bare kind => "<kind>.json", profile target
// => "<kind>@<profile>.json", under <stateDir>/adapters/.
export function ledgerPath(stateDir: string, agentKind: AgentKind | string, profile: string | null): string {
  const name = profile ? `${agentKind}@${profile}` : `${agentKind}`;
  return path.join(stateDir, "adapters", `${name}.json`);
}

export function installAdapter(adapter: Adapter, ctx: InstallContext): InstallRecord {
  const record = adapter.install(ctx);
  const p = ledgerPath(ctx.stateDir, ctx.agentKind, ctx.profile);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(record, null, 2));
  return record;
}

export function loadRecord(stateDir: string, agentKind: AgentKind | string, profile: string | null): InstallRecord | null {
  const p = ledgerPath(stateDir, agentKind, profile);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8")) as InstallRecord;
}

export function uninstallAdapter(adapter: Adapter, ctx: InstallContext): boolean {
  const record = loadRecord(ctx.stateDir, ctx.agentKind, ctx.profile);
  if (!record) return false;
  adapter.uninstall(ctx, record);
  fs.rmSync(ledgerPath(ctx.stateDir, ctx.agentKind, ctx.profile), { force: true });
  return true;
}
