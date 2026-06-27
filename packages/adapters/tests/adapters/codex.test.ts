import { test, expect } from "bun:test";
import { CODEX_SOURCES, CODEX_CAPABILITIES } from "../../src/adapters/codex/caps.ts";
import { isManifestPoint } from "../../src/core/manifest.ts";

test("every codex source point is a valid manifest point", () => {
  for (const s of CODEX_SOURCES) for (const p of s.points) expect(isManifestPoint(p)).toBe(true);
});

test("every fulfilled codex capability is covered by a source", () => {
  const covered = new Set(CODEX_SOURCES.flatMap((s) => s.points as string[]));
  for (const [pt, d] of Object.entries(CODEX_CAPABILITIES)) {
    if (d.fulfil !== "no") expect(covered.has(pt)).toBe(true);
  }
});

test("usage is transcript-delta + backfilled; turns are hook-command + live; input.required partial", () => {
  expect(CODEX_CAPABILITIES["usage.reported"]).toMatchObject({ source: "transcript-delta", liveness: "backfilled" });
  expect(CODEX_CAPABILITIES["turn.started"]).toMatchObject({ source: "hook-command", liveness: "live" });
  expect(CODEX_CAPABILITIES["input.required"]?.fulfil).toBe("partial");
});

import { codexResumePlan } from "../../src/adapters/codex/resume.ts";

const resumeCtx = (nid: string | null) => ({
  agentKind: "codex" as const, profile: null, command: "codex", args: ["--model", "gpt-5.5"],
  cwd: "/work", env: { FOO: "1" }, nativeSessionId: nid,
});

test("codex resumePlan builds `codex resume <id>` preserving original args", () => {
  const plan = codexResumePlan(resumeCtx("019e7396-de62-7f91-9a3d-df4b0a99aaaf"));
  expect(plan.resumable).toBe(true);
  expect(plan.argv).toEqual(["codex", "resume", "019e7396-de62-7f91-9a3d-df4b0a99aaaf", "--model", "gpt-5.5"]);
  expect(plan.cwd).toBe("/work");
  expect(plan.nativeSessionId).toBe("019e7396-de62-7f91-9a3d-df4b0a99aaaf");
});

test("codex resumePlan is not resumable without a native session id", () => {
  expect(codexResumePlan(resumeCtx(null))).toEqual({ resumable: false });
});

import { normalizeCodex } from "../../src/adapters/codex/normalize.ts";

const target = { agentKind: "codex" as const, profile: null };

test("session.registered builds the native lifecycle root from stdin + env", () => {
  const out = normalizeCodex({
    point: "session.registered", source: "hook-command",
    raw: { session_id: "nat-9", cwd: "/work" }, target,
    env: { AGMUX_AGENT_PID: "5151", TMUX_PANE: "%4", AGMUX_PROFILE: "work", CODEX_VERSION: "0.135.0" },
  });
  expect(out.events).toHaveLength(1);
  const p = out.events[0]!.payload as any;
  expect(out.events[0]!.kind).toBe("session.registered");
  expect(p.native_session_id).toBe("nat-9");
  expect(p.agent_kind).toBe("codex");
  expect(p.pid).toBe(5151);
  expect(p.cwd).toBe("/work");
  expect(p.tmux_pane).toBe("%4");
  expect(p.profile).toBe("work");
  expect(p.agent_version).toBe("0.135.0");
  expect(p.parent).toBeNull();
});

test("session.registered stores null pid when AGMUX_AGENT_PID is absent/garbage", () => {
  const out = normalizeCodex({
    point: "session.registered", source: "hook-command",
    raw: { session_id: "nat-x" }, target, env: { AGMUX_AGENT_PID: "notanum" },
  });
  expect((out.events[0]!.payload as any).pid).toBeNull();
});

test("session.registered/linked are no-ops without a session_id", () => {
  expect(normalizeCodex({ point: "session.registered", source: "hook-command", raw: {}, target }).events).toHaveLength(0);
  expect(normalizeCodex({ point: "session.linked", source: "hook-command", raw: {}, target }).events).toHaveLength(0);
});

test("session.linked maps native session id from stdin", () => {
  const out = normalizeCodex({ point: "session.linked", source: "hook-command", raw: { session_id: "sess-abc" }, target });
  expect(out.events).toEqual([{ kind: "session.linked", payload: { native_session_id: "sess-abc" } }]);
});

test("turn.started / turn.ended map to canonical events", () => {
  expect(normalizeCodex({ point: "turn.started", source: "hook-command", raw: {}, target }).events[0]?.kind).toBe("turn.started");
  const ended = normalizeCodex({ point: "turn.ended", source: "hook-command", raw: { reason: "completed" }, target });
  expect(ended.events[0]).toEqual({ kind: "turn.ended", payload: { reason: "completed" } });
});

test("input.required is always a permission (Codex PermissionRequest is permission-only)", () => {
  expect(normalizeCodex({ point: "input.required", source: "hook-command", raw: {}, target }).events[0]?.payload).toEqual({ kind: "permission" });
});

test("prompt.sent is redacted (chars only); tool.used carries the tool name", () => {
  expect(normalizeCodex({ point: "prompt.sent", source: "hook-command", raw: { prompt: "hello" }, target }).events[0]?.payload).toEqual({ chars: 5, redacted: true });
  expect(normalizeCodex({ point: "tool.used", source: "hook-command", raw: { tool_name: "Bash" }, target }).events[0]?.payload).toEqual({ tool: "Bash", ok: true });
});

import * as path from "node:path";
import { fileURLToPath } from "node:url";

const FX = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "codex");
const transcript = path.join(FX, "transcript.sample.jsonl");

test("usage.reported reads token_count deltas (last_token_usage) and advances the cursor", () => {
  const out = normalizeCodex({
    point: "usage.reported", source: "transcript-delta",
    raw: { session_id: "sess-x", transcript_path: transcript, model: "gpt-5.5", turn_id: "t-1" },
    cursor: null, target,
  });
  expect(out.events).toHaveLength(2); // two token_count records; response_item skipped
  expect(out.events[0]).toMatchObject({
    kind: "usage.reported",
    payload: {
      cumulative: false, source: "transcript-delta", model: "gpt-5.5",
      input_tokens: 10768, output_tokens: 270, cache_read_tokens: 1920, cache_write_tokens: null,
      reasoning_output_tokens: 82, total_tokens: 11038, model_context_window: 258400, turn_id: "t-1",
    },
  });
  expect((out.events[0]!.payload as any).rate_limit).toMatchObject({ used_percent: 5.0 });
  // Second record carries its own per-turn delta (last_token_usage, not the cumulative total).
  expect(out.events[1]!.payload).toMatchObject({ input_tokens: 15029, output_tokens: 381, cache_read_tokens: 10624 });

  // dedup keys are byte-offset based, distinct, and monotonic.
  const k0 = out.events[0]!.dedup_key!;
  const k1 = out.events[1]!.dedup_key!;
  expect(k0).toMatch(/^codex:transcript-delta:sess-x:\d+$/);
  expect(k1).toMatch(/^codex:transcript-delta:sess-x:\d+$/);
  expect(Number(k1.split(":").pop())).toBeGreaterThan(Number(k0.split(":").pop()));
  expect(Number(out.cursor)).toBeGreaterThan(0);

  // Re-reading from the advanced cursor yields nothing new.
  const again = normalizeCodex({
    point: "usage.reported", source: "transcript-delta",
    raw: { session_id: "sess-x", transcript_path: transcript }, cursor: out.cursor, target,
  });
  expect(again.events).toHaveLength(0);
});

test("usage.reported with a missing transcript path is a no-op", () => {
  expect(normalizeCodex({ point: "usage.reported", source: "transcript-delta", raw: { session_id: "x", transcript_path: "/no/such/file" }, cursor: null, target }).events).toHaveLength(0);
});

import { MARKETPLACE_FILES, PLUGIN_VERSION, MARKETPLACE_NAME, PLUGIN_NAME } from "../../src/adapters/codex/plugin-files.ts";

test("marketplace payload contains manifest, plugin manifest, hooks, and an executable shim", () => {
  const byPath = new Map(MARKETPLACE_FILES.map((f) => [f.path, f]));
  expect(byPath.has(".agents/plugins/marketplace.json")).toBe(true);
  expect(byPath.has("plugins/agmux/.codex-plugin/plugin.json")).toBe(true);
  expect(byPath.has("plugins/agmux/hooks/hooks.json")).toBe(true);
  expect(byPath.get("plugins/agmux/bin/agmux-emit")!.mode & 0o111).not.toBe(0); // executable
});

test("marketplace manifest references the local plugin; plugin manifest carries the version", () => {
  const mkt = JSON.parse(MARKETPLACE_FILES.find((f) => f.path === ".agents/plugins/marketplace.json")!.content);
  expect(mkt.name).toBe(MARKETPLACE_NAME);
  expect(mkt.plugins[0]).toMatchObject({ name: PLUGIN_NAME, source: { source: "local", path: "./plugins/agmux" } });
  const plugin = JSON.parse(MARKETPLACE_FILES.find((f) => f.path === "plugins/agmux/.codex-plugin/plugin.json")!.content);
  expect(plugin).toMatchObject({ name: PLUGIN_NAME, version: PLUGIN_VERSION });
});

test("hooks wire every manifest point to `agmux emit --from=codex`", () => {
  const hooks = JSON.parse(MARKETPLACE_FILES.find((f) => f.path === "plugins/agmux/hooks/hooks.json")!.content).hooks;
  const all = JSON.stringify(hooks);
  for (const ev of ["SessionStart", "UserPromptSubmit", "Stop", "PermissionRequest", "PostToolUse"]) {
    expect(Object.keys(hooks)).toContain(ev);
  }
  expect(all).toContain("--from=codex");
  expect(all).toContain("--point=session.registered");
  expect(all).toContain("--point=usage.reported");
  expect(all).toContain("--point=input.required");
});

test("hooks are synchronous + self-backgrounding (codex 0.135 skips async:true)", () => {
  // Regression: codex 0.135 warns "async hooks are not supported yet" and SKIPS
  // any hook with `async:true`, so every agmux hook silently never fires. The
  // non-blocking intent must instead be carried by forking inside the command.
  const hooks = JSON.parse(MARKETPLACE_FILES.find((f) => f.path === "plugins/agmux/hooks/hooks.json")!.content).hooks;
  const cmds = (Object.values(hooks) as any[]).flatMap((entries) => entries.flatMap((e: any) => e.hooks));
  expect(cmds.length).toBeGreaterThan(0);
  for (const h of cmds) {
    expect(h.async).toBeUndefined();                 // no unsupported async field
    expect(h.command).toMatch(/^\(\s.*\s&\s\)$/);     // sync hook that forks + returns
  }
});

import { resolveConfigDir, marketplaceDir, codexInstall, codexUninstall, codexStatus, setCodexRunner, ADAPTER_VERSION, type CodexRunner } from "../../src/adapters/codex/install.ts";
import * as os from "node:os";
import * as fs from "node:fs";

// Stateful fake `codex` CLI: tracks install state per CODEX_HOME and renders a
// realistic `codex plugin list` table. `versionOverride` lets a test force drift.
function makeFakeCodex(versionOverride?: string) {
  const installed = new Set<string>();
  const calls: string[][] = [];
  const run: CodexRunner = (args, env) => {
    calls.push(args);
    const home = env.CODEX_HOME ?? "";
    const sub = args.join(" ");
    if (sub === "plugin add agmux@agmux") { installed.add(home); return { code: 0, stdout: "", stderr: "" }; }
    if (sub === "plugin remove agmux@agmux") { installed.delete(home); return { code: 0, stdout: "", stderr: "" }; }
    if (sub === "plugin list") {
      const ver = versionOverride ?? PLUGIN_VERSION;
      const row = installed.has(home)
        ? `agmux@agmux  installed, enabled  ${ver}  /x`
        : `agmux@agmux   not installed          /x`;
      return { code: 0, stdout: `PLUGIN        STATUS         VERSION  PATH\n${row}\n`, stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" }; // marketplace add/remove
  };
  return { run, calls, installed };
}

function tmpCfg(): string { return fs.mkdtempSync(path.join(os.tmpdir(), "agmux-codex-cfg-")); }
function tmpState(): string { return fs.mkdtempSync(path.join(os.tmpdir(), "agmux-codex-state-")); }

const ictx = (configDir: string | undefined, stateDir: string, profile: string | null = null, override: string | null = null) => ({
  agentKind: "codex" as const, profile,
  profileEnv: (configDir ? { CODEX_HOME: configDir } : {}) as Record<string, string>,
  agmuxEmitPath: "/abs/agmux emit", stateDir,
  ...(override ? { configDirOverride: override } : {}),
});

test("resolveConfigDir: explicit override > profileEnv CODEX_HOME > default ~/.codex", () => {
  expect(resolveConfigDir(ictx("/cfg", "/s"))).toBe("/cfg");
  expect(resolveConfigDir(ictx("/cfg", "/s", null, "/override"))).toBe("/override");
  expect(resolveConfigDir(ictx(undefined, "/s")).endsWith("/.codex")).toBe(true);
});

test("install materializes the marketplace, runs codex plugin add, and flips status; uninstall reverses", () => {
  const fake = makeFakeCodex();
  setCodexRunner(fake.run);
  try {
    const cfg = tmpCfg();
    const state = tmpState();
    const ctx = ictx(cfg, state, "work");

    expect(codexStatus(ctx).installed).toBe(false);
    const rec = codexInstall(ctx);
    expect(rec).toMatchObject({ agentKind: "codex", profile: "work", adapterVersion: ADAPTER_VERSION, isolationMode: "config-dir" });

    // Marketplace fully materialized on disk.
    const mkt = marketplaceDir(state);
    expect(fs.existsSync(path.join(mkt, ".agents/plugins/marketplace.json"))).toBe(true);
    expect(fs.existsSync(path.join(mkt, "plugins/agmux/hooks/hooks.json"))).toBe(true);
    expect(fs.statSync(path.join(mkt, "plugins/agmux/bin/agmux-emit")).mode & 0o111).not.toBe(0);

    // The official commands were invoked, CODEX_HOME-scoped.
    expect(fake.calls.some((c) => c[0] === "plugin" && c[1] === "marketplace" && c[2] === "add")).toBe(true);
    expect(fake.calls.some((c) => c.join(" ") === "plugin add agmux@agmux")).toBe(true);

    expect(codexStatus(ctx)).toMatchObject({ installed: true, version: ADAPTER_VERSION, drift: false, runtimeGate: "hook-trust" });

    codexUninstall(ctx, rec);
    expect(codexStatus(ctx).installed).toBe(false);
  } finally {
    setCodexRunner(null);
  }
});

test("status reports drift when the installed plugin version differs from the embedded payload", () => {
  const fake = makeFakeCodex("0.0.1-stale");
  setCodexRunner(fake.run);
  try {
    const ctx = ictx(tmpCfg(), tmpState());
    codexInstall(ctx);
    expect(codexStatus(ctx).drift).toBe(true);
  } finally {
    setCodexRunner(null);
  }
});

test("separate CODEX_HOME dirs install independently (profile isolation)", () => {
  const fake = makeFakeCodex();
  setCodexRunner(fake.run);
  try {
    const state = tmpState();
    const cfgA = tmpCfg();
    const cfgB = tmpCfg();
    codexInstall(ictx(cfgA, state));
    expect(codexStatus(ictx(cfgA, state)).installed).toBe(true);
    expect(codexStatus(ictx(cfgB, state)).installed).toBe(false);
  } finally {
    setCodexRunner(null);
  }
});

test("install throws when `codex plugin add` exits non-zero (no silent success)", () => {
  const failing: CodexRunner = (args) =>
    args.join(" ") === "plugin add agmux@agmux"
      ? { code: 1, stdout: "", stderr: "trust required" }
      : { code: 0, stdout: "", stderr: "" };
  setCodexRunner(failing);
  try {
    expect(() => codexInstall(ictx(tmpCfg(), tmpState()))).toThrow(/codex plugin add agmux@agmux failed \(exit 1\): trust required/);
  } finally {
    setCodexRunner(null);
  }
});

test("status surfaces stderr detail when `codex plugin list` errors", () => {
  const failing: CodexRunner = () => ({ code: 1, stdout: "", stderr: "codex not found" });
  setCodexRunner(failing);
  try {
    const st = codexStatus(ictx(tmpCfg(), tmpState()));
    expect(st.installed).toBe(false);
    expect(st.detail).toBe("codex not found");
  } finally {
    setCodexRunner(null);
  }
});

import { codexAdapter } from "../../src/adapters/codex/index.ts";
import { assertAdapterConformance } from "../../src/core/conformance.ts";

test("the codexAdapter exposes the expected shape", () => {
  expect(codexAdapter.agentKind).toBe("codex");
  expect(codexAdapter.sources({} as any).length).toBe(2);
  expect(Object.keys(codexAdapter.capabilities({} as any))).toContain("usage.reported");
  // Codex has no native session-id env var → nativeIdFromEnv is intentionally omitted.
  expect(codexAdapter.nativeIdFromEnv).toBeUndefined();
});

test("codexAdapter passes the framework conformance battery (fake codex runner)", () => {
  const fake = makeFakeCodex();
  setCodexRunner(fake.run);
  try {
    const cfg = tmpCfg();
    const state = tmpState();
    const passed = assertAdapterConformance(codexAdapter, {
      makeContext: () => ({ agentKind: "codex", profile: null, profileEnv: { CODEX_HOME: cfg }, agmuxEmitPath: "/abs/agmux emit", stateDir: state }),
      makeResumeContext: (nid) => ({ agentKind: "codex", profile: null, command: "codex", args: [], cwd: "/work", env: {}, nativeSessionId: nid }),
    });
    expect(passed).toEqual(["identity", "sources", "capabilities", "install-roundtrip", "resumePlan", "relaunch-env-keys"]);
  } finally {
    setCodexRunner(null);
  }
});

test("status parses the real `installed, enabled` STATUS phrase without false drift", () => {
  const realish: CodexRunner = (args) =>
    args.join(" ") === "plugin list"
      ? { code: 0, stdout: `PLUGIN       STATUS              VERSION  PATH\nagmux@agmux  installed, enabled  ${PLUGIN_VERSION}  /p/plugins/agmux\n`, stderr: "" }
      : { code: 0, stdout: "", stderr: "" };
  setCodexRunner(realish);
  try {
    const st = codexStatus(ictx(tmpCfg(), tmpState()));
    expect(st.installed).toBe(true);
    expect(st.drift).toBe(false); // VERSION column parsed correctly, not ","
  } finally {
    setCodexRunner(null);
  }
});

test("tool.used reflects exit_code: 0 → ok, non-zero → fail, absent → ok", () => {
  const t = { agentKind: "codex" as const, profile: null };
  const ok = normalizeCodex({ point: "tool.used", source: "hook-command", raw: { tool_name: "Bash", tool_response: { exit_code: 0 } }, target: t });
  expect(ok.events[0]?.payload).toEqual({ tool: "Bash", ok: true });

  const fail = normalizeCodex({ point: "tool.used", source: "hook-command", raw: { tool_name: "Bash", tool_response: { exit_code: 1 } }, target: t });
  expect(fail.events[0]?.payload).toEqual({ tool: "Bash", ok: false, detail: "exit 1" });

  // No tool_response (e.g. a non-shell tool) → default to ok, no detail.
  const absent = normalizeCodex({ point: "tool.used", source: "hook-command", raw: { tool_name: "apply_patch" }, target: t });
  expect(absent.events[0]?.payload).toEqual({ tool: "apply_patch", ok: true });
});
