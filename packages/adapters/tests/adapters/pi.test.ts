import { test, expect } from "bun:test";
import { PI_SOURCES, PI_CAPABILITIES } from "../../src/adapters/pi/caps.ts";
import { isManifestPoint } from "../../src/core/manifest.ts";

test("every pi source point is a valid manifest point", () => {
  for (const s of PI_SOURCES) for (const p of s.points) expect(isManifestPoint(p)).toBe(true);
});

test("every fulfilled pi capability is covered by a source", () => {
  const covered = new Set(PI_SOURCES.flatMap((s) => s.points as string[]));
  for (const [pt, d] of Object.entries(PI_CAPABILITIES)) {
    if (d.fulfil !== "no") expect(covered.has(pt)).toBe(true);
  }
});

test("usage is hook-command + live (no transcript tailing); input.required is absent", () => {
  expect(PI_CAPABILITIES["usage.reported"]).toMatchObject({ source: "hook-command", liveness: "live" });
  expect(PI_CAPABILITIES["turn.started"]).toMatchObject({ source: "hook-command", liveness: "live" });
  expect(PI_CAPABILITIES["input.required"]).toBeUndefined();
});

import { piResumePlan } from "../../src/adapters/pi/resume.ts";

const resumeCtx = (nid: string | null) => ({
  agentKind: "pi" as const, profile: null, command: "pi", args: ["--model", "gpt-5.5"],
  cwd: "/work", env: { FOO: "1" }, nativeSessionId: nid,
});

test("pi resumePlan builds `pi --session <id>` preserving original args", () => {
  const plan = piResumePlan(resumeCtx("019e6415-f214-72d2-8352-afd93f03133c"));
  expect(plan.resumable).toBe(true);
  expect(plan.argv).toEqual(["pi", "--session", "019e6415-f214-72d2-8352-afd93f03133c", "--model", "gpt-5.5"]);
  expect(plan.cwd).toBe("/work");
  expect(plan.nativeSessionId).toBe("019e6415-f214-72d2-8352-afd93f03133c");
});

test("pi resumePlan is not resumable without a native session id", () => {
  expect(piResumePlan(resumeCtx(null))).toEqual({ resumable: false });
});

import { EXTENSION_FILES, EXTENSION_FILENAME, PLUGIN_VERSION } from "../../src/adapters/pi/extension-files.ts";

test("extension payload is a single auto-discoverable agmux.ts", () => {
  expect(EXTENSION_FILES).toHaveLength(1);
  expect(EXTENSION_FILES[0]!.path).toBe(EXTENSION_FILENAME);
  expect(EXTENSION_FILENAME).toBe("agmux.ts");
});

test("extension source carries the version marker, a default export, and emits --from=pi for each point", () => {
  const src = EXTENSION_FILES[0]!.content;
  expect(src).toContain(`agmux-pi-extension v${PLUGIN_VERSION}`);
  expect(src).toContain("export default function");
  expect(src).toContain("--from=pi");
  // session.registered / session.linked are emitted via direct emit([...]) with a literal flag.
  for (const p of ["session.registered", "session.linked"]) {
    expect(src).toContain(`"--point=${p}"`);
  }
  // The remaining points are emitted via emitPoint("<p>", ...) — the flag is built as "--point=" + point.
  for (const p of ["turn.started", "turn.ended", "tool.used", "prompt.sent", "usage.reported"]) {
    expect(src).toContain(`emitPoint("${p}"`);
  }
  // Registers a handler for every PI event we consume.
  for (const ev of ["session_start", "input", "agent_start", "tool_result", "message_end", "agent_end"]) {
    expect(src).toContain(`pi.on("${ev}"`);
  }
  // Fire-and-forget: detached spawn, unref, never awaited.
  expect(src).toContain("detached: true");
  expect(src).toContain(".unref()");
});

import { normalizePi } from "../../src/adapters/pi/normalize.ts";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";

const target = { agentKind: "pi" as const, profile: null };
const FX = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "pi", "hook-stdin.sample.json");
const SAMPLE = JSON.parse(fs.readFileSync(FX, "utf8"));

test("session.registered builds the native lifecycle root from stdin + env", () => {
  const out = normalizePi({
    point: "session.registered", source: "hook-command",
    raw: SAMPLE.session_start, target,
    env: { TMUX_PANE: "%4", AGMUX_PROFILE: "work", PI_VERSION: "0.75.5" },
  });
  expect(out.events).toHaveLength(1);
  const p = out.events[0]!.payload as any;
  expect(out.events[0]!.kind).toBe("session.registered");
  expect(p.native_session_id).toBe("019e6415-f214-72d2-8352-afd93f03133c");
  expect(p.agent_kind).toBe("pi");
  expect(p.pid).toBe(4242);
  expect(p.cwd).toBe("/work");
  expect(p.tmux_pane).toBe("%4");
  expect(p.profile).toBe("work");
  expect(p.agent_version).toBe("0.75.5");
  expect(p.parent).toBeNull();
});

test("session.registered falls back to AGMUX_AGENT_PID when payload pid is absent", () => {
  const out = normalizePi({
    point: "session.registered", source: "hook-command",
    raw: { session_id: "nat-x" }, target, env: { AGMUX_AGENT_PID: "5151" },
  });
  expect((out.events[0]!.payload as any).pid).toBe(5151);
});

test("session.registered/linked are no-ops without a session_id", () => {
  expect(normalizePi({ point: "session.registered", source: "hook-command", raw: {}, target }).events).toHaveLength(0);
  expect(normalizePi({ point: "session.linked", source: "hook-command", raw: {}, target }).events).toHaveLength(0);
});

test("session.linked maps native session id from stdin", () => {
  const out = normalizePi({ point: "session.linked", source: "hook-command", raw: SAMPLE.session_resume, target });
  expect(out.events).toEqual([{ kind: "session.linked", payload: { native_session_id: "019e6415-f214-72d2-8352-afd93f03133c" } }]);
});

test("turn.started / turn.ended map to canonical events", () => {
  expect(normalizePi({ point: "turn.started", source: "hook-command", raw: {}, target }).events[0]?.kind).toBe("turn.started");
  expect(normalizePi({ point: "turn.ended", source: "hook-command", raw: {}, target }).events[0]).toEqual({ kind: "turn.ended", payload: { reason: null } });
});

test("prompt.sent is redacted (chars only); tool.used carries the tool name and ok", () => {
  expect(normalizePi({ point: "prompt.sent", source: "hook-command", raw: SAMPLE.input, target }).events[0]?.payload).toEqual({ chars: 19, redacted: true });
  expect(normalizePi({ point: "tool.used", source: "hook-command", raw: SAMPLE.tool_result, target }).events[0]?.payload).toEqual({ tool: "bash", ok: true });
  expect(normalizePi({ point: "tool.used", source: "hook-command", raw: { tool_name: "bash", is_error: true }, target }).events[0]?.payload).toEqual({ tool: "bash", ok: false, detail: "error" });
});

test("usage.reported maps message_end usage into a per-message delta with a stable dedup key", () => {
  const out = normalizePi({ point: "usage.reported", source: "hook-command", raw: SAMPLE.message_end, target });
  expect(out.events).toHaveLength(1);
  expect(out.events[0]).toMatchObject({
    kind: "usage.reported",
    payload: {
      cumulative: false, source: "hook-command", model: "gpt-5.5",
      input_tokens: 1200, output_tokens: 340, cache_read_tokens: 800, cache_write_tokens: 0,
      reasoning_output_tokens: 64, total_tokens: 1604, model_context_window: 258400,
    },
  });
  expect(out.events[0]!.dedup_key).toBe("pi:hook-command:019e6415-f214-72d2-8352-afd93f03133c:m-1");
});

test("usage.reported is a no-op when no usage object is present", () => {
  expect(normalizePi({ point: "usage.reported", source: "hook-command", raw: { session_id: "x" }, target }).events).toHaveLength(0);
});

test("usage.reported tolerates camelCase token field variants (defensive mapping)", () => {
  const out = normalizePi({ point: "usage.reported", source: "hook-command",
    raw: { session_id: "s", message_id: "m2", usage: { inputTokens: 5, outputTokens: 7 } }, target });
  expect(out.events[0]!.payload).toMatchObject({ input_tokens: 5, output_tokens: 7, total_tokens: null });
});

import { resolveConfigDir, extensionsDir, piInstall, piUninstall, piStatus, ADAPTER_VERSION } from "../../src/adapters/pi/install.ts";
import * as os from "node:os";

function tmpCfg(): string { return fs.mkdtempSync(path.join(os.tmpdir(), "agmux-pi-cfg-")); }
function tmpState(): string { return fs.mkdtempSync(path.join(os.tmpdir(), "agmux-pi-state-")); }

const ictx = (configDir: string | undefined, stateDir: string, profile: string | null = null, override: string | null = null) => ({
  agentKind: "pi" as const, profile,
  profileEnv: (configDir ? { PI_CODING_AGENT_DIR: configDir } : {}) as Record<string, string>,
  agmuxEmitPath: "/abs/agmux emit", stateDir,
  ...(override ? { configDirOverride: override } : {}),
});

test("resolveConfigDir: explicit override > profileEnv PI_CODING_AGENT_DIR > default ~/.pi/agent", () => {
  expect(resolveConfigDir(ictx("/cfg", "/s"))).toBe("/cfg");
  expect(resolveConfigDir(ictx("/cfg", "/s", null, "/override"))).toBe("/override");
  expect(resolveConfigDir(ictx(undefined, "/s")).endsWith("/.pi/agent")).toBe(true);
});

test("install writes agmux.ts into <configDir>/extensions; status flips; uninstall reverses", () => {
  const cfg = tmpCfg();
  const ctx = ictx(cfg, tmpState(), "work");
  expect(piStatus(ctx).installed).toBe(false);

  const rec = piInstall(ctx);
  expect(rec).toMatchObject({ agentKind: "pi", profile: "work", adapterVersion: ADAPTER_VERSION, isolationMode: "config-dir" });
  expect(fs.existsSync(path.join(extensionsDir(cfg), "agmux.ts"))).toBe(true);
  expect(piStatus(ctx)).toMatchObject({ installed: true, version: ADAPTER_VERSION, drift: false, runtimeGate: "hook-trust" });

  piUninstall(ctx, rec);
  expect(piStatus(ctx).installed).toBe(false);
  // Uninstall removes only the file, not the extensions dir (may hold others).
  expect(fs.existsSync(extensionsDir(cfg))).toBe(true);
});

test("status reports drift when the installed marker version differs from the payload", () => {
  const cfg = tmpCfg();
  const ctx = ictx(cfg, tmpState());
  piInstall(ctx);
  const file = path.join(extensionsDir(cfg), "agmux.ts");
  fs.writeFileSync(file, "// agmux-pi-extension v0.0.1-stale\n");
  expect(piStatus(ctx).drift).toBe(true);
});

test("separate PI_CODING_AGENT_DIR dirs install independently (profile isolation)", () => {
  const state = tmpState();
  const cfgA = tmpCfg();
  const cfgB = tmpCfg();
  piInstall(ictx(cfgA, state));
  expect(piStatus(ictx(cfgA, state)).installed).toBe(true);
  expect(piStatus(ictx(cfgB, state)).installed).toBe(false);
});

import { piAdapter } from "../../src/adapters/pi/index.ts";
import { assertAdapterConformance } from "../../src/core/conformance.ts";

test("the piAdapter exposes the expected shape", () => {
  expect(piAdapter.agentKind).toBe("pi");
  expect(piAdapter.sources({} as any).length).toBe(1);
  expect(Object.keys(piAdapter.capabilities({} as any))).toContain("usage.reported");
  // PI exposes no native session-id env var → nativeIdFromEnv is omitted; identity
  // comes from stdin (the session-file UUID the extension emits).
  expect(piAdapter.nativeIdFromEnv).toBeUndefined();
  expect(piAdapter.nativeIdFromStdin!({ session_id: "abc" })).toBe("abc");
  expect(piAdapter.nativeIdFromStdin!({})).toBeNull();
});

test("piAdapter passes the framework conformance battery", () => {
  const cfg = tmpCfg();
  const state = tmpState();
  const passed = assertAdapterConformance(piAdapter, {
    makeContext: () => ({ agentKind: "pi", profile: null, profileEnv: { PI_CODING_AGENT_DIR: cfg }, agmuxEmitPath: "/abs/agmux emit", stateDir: state }),
    makeResumeContext: (nid) => ({ agentKind: "pi", profile: null, command: "pi", args: [], cwd: "/work", env: {}, nativeSessionId: nid }),
  });
  expect(passed).toEqual(["identity", "sources", "capabilities", "install-roundtrip", "resumePlan", "relaunch-env-keys"]);
});
