import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { InstallContext, InstallRecord, InstallStatus } from "../../core/types.ts";
import { PI_CAPABILITIES } from "./caps.ts";
import { EXTENSION_FILES, EXTENSION_FILENAME, PLUGIN_VERSION } from "./extension-files.ts";

export const ADAPTER_VERSION = "1";

// Install model (spec §2): drop the embedded extension into <configDir>/extensions/,
// which PI auto-discovers — no settings.json edit, no marketplace, no `pi` binary.
// Pure filesystem, fully reversible. Mirrors Claude's skills-dir model.

// config-dir isolation (spec §1): explicit CLI override > profile's
// PI_CODING_AGENT_DIR > default ~/.pi/agent. The PI analogue of CLAUDE_CONFIG_DIR
// / CODEX_HOME.
export function resolveConfigDir(ctx: InstallContext): string {
  return ctx.configDirOverride ?? ctx.profileEnv.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
}

export function extensionsDir(configDir: string): string {
  return path.join(configDir, "extensions");
}

function extensionPath(configDir: string): string {
  return path.join(extensionsDir(configDir), EXTENSION_FILENAME);
}

// Read the version stamped in the extension's marker line (the analogue of
// reading plugin.json's version). null = not installed / unreadable.
function readInstalledVersion(file: string): string | null {
  if (!fs.existsSync(file)) return null;
  try {
    const head = fs.readFileSync(file, "utf8").slice(0, 200);
    const m = head.match(/agmux-pi-extension v(\S+)/);
    return m ? m[1]! : null;
  } catch { return null; }
}

export function piInstall(ctx: InstallContext): InstallRecord {
  const configDir = resolveConfigDir(ctx);
  const dir = extensionsDir(configDir);
  for (const f of EXTENSION_FILES) {
    const target = path.join(dir, f.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, f.content, { mode: f.mode });
  }
  return {
    agentKind: "pi",
    profile: ctx.profile,
    adapterVersion: ADAPTER_VERSION,
    isolationMode: "config-dir",
    capabilities: PI_CAPABILITIES,
    artifacts: [{ kind: "file", path: extensionPath(configDir), detail: "pi extension agmux.ts" }],
  };
}

export function piUninstall(_ctx: InstallContext, record: InstallRecord): void {
  // Remove only the extension file — never the extensions/ dir, which may hold
  // user/other-profile extensions.
  for (const a of record.artifacts) {
    if (a.kind === "file") fs.rmSync(a.path, { force: true });
  }
}

export function piStatus(ctx: InstallContext): InstallStatus {
  const file = extensionPath(resolveConfigDir(ctx));
  const installedVersion = readInstalledVersion(file);
  const installed = installedVersion !== null;
  const drift = installed && installedVersion !== PLUGIN_VERSION;
  // Auto-load may still be gated by a per-extension trust prompt at session start
  // (spec §8.3); kept until a live session proves the extension loads ungated.
  return { installed, version: installed ? ADAPTER_VERSION : null, drift, runtimeGate: "hook-trust" };
}
