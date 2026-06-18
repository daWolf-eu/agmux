// The agmux PI extension payload, embedded as a string (cf. codex/plugin-files.ts,
// claude/plugin-files.ts). install() WRITES this to <configDir>/extensions/agmux.ts,
// which PI auto-discovers. Embedded as code (not an on-disk data file) so the
// adapter behaves identically from source and from a `bun build --compile` binary.

export const PLUGIN_VERSION = "1.0.0";
export const EXTENSION_FILENAME = "agmux.ts";
export const VERSION_MARKER = `agmux-pi-extension v${PLUGIN_VERSION}`;

// Each handler spawns `agmux emit` DETACHED and never awaits — telemetry must
// never block PI's event loop or alter its behavior (handlers return nothing).
// The child inherits process.env, so AGMUX_SESSION_ID / AGMUX_PROFILE /
// AGMUX_HUB_URL / TMUX_PANE (when wrapper-launched) flow through automatically.
const EXTENSION_SOURCE = `// ${VERSION_MARKER}
// agmux session telemetry for PI — auto-discovered from <configDir>/extensions/.
// DO NOT EDIT: managed by \`agmux adapter install\`.
import { spawn } from "node:child_process";
import * as path from "node:path";

function agmuxBin() {
  return process.env.AGMUX_BIN || "agmux";
}

// Native id = the UUID after the last "_" in the session filename
// (<ts>_<uuid>.jsonl); null for ephemeral/-p sessions (getSessionFile() === null).
function sessionId(ctx) {
  const file = ctx && ctx.sessionManager && ctx.sessionManager.getSessionFile
    ? ctx.sessionManager.getSessionFile() : null;
  if (!file) return null;
  const base = path.basename(String(file)).replace(/\\.jsonl$/, "");
  const idx = base.lastIndexOf("_");
  return idx >= 0 ? base.slice(idx + 1) : base;
}

function emit(args, payload) {
  try {
    const child = spawn(agmuxBin(), ["emit", "--from=pi"].concat(args), {
      stdio: ["pipe", "ignore", "ignore"],
      detached: true,
    });
    child.on("error", function () {});
    child.stdin.end(JSON.stringify(payload));
    child.unref();
  } catch (_e) {
    // telemetry must never break the agent
  }
}

function emitPoint(point, ctx, extra) {
  emit(["--source=hook-command", "--point=" + point], Object.assign({ session_id: sessionId(ctx) }, extra));
}

export default function (pi) {
  pi.on("session_start", function (event, ctx) {
    var sid = sessionId(ctx);
    emit(["--source=hook-command", "--point=session.registered"], { session_id: sid, cwd: (ctx && ctx.cwd) || null, pid: process.pid });
    emit(["--attach"], { session_id: sid });
    if (event && (event.reason === "resume" || event.reason === "fork")) {
      emit(["--source=hook-command", "--point=session.linked"], { session_id: sid });
    }
  });

  pi.on("input", function (event, ctx) {
    var text = event && typeof event.text === "string" ? event.text
      : (event && typeof event.input === "string" ? event.input : "");
    emitPoint("prompt.sent", ctx, { prompt: text });
  });

  pi.on("agent_start", function (_event, ctx) {
    emitPoint("turn.started", ctx, {});
  });

  pi.on("tool_result", function (event, ctx) {
    emitPoint("tool.used", ctx, { tool_name: (event && event.toolName) || null, is_error: !!(event && event.isError) });
  });

  pi.on("message_end", function (event, ctx) {
    var msg = event && event.message;
    if (!msg || !msg.usage) return;
    emitPoint("usage.reported", ctx, { usage: msg.usage, model: msg.model || null, message_id: msg.id || null });
  });

  pi.on("agent_end", function (_event, ctx) {
    emitPoint("turn.ended", ctx, {});
  });
}
`;

export interface ExtensionFile {
  path: string;  // relative to the extensions/ dir
  content: string;
  mode: number;
}

export const EXTENSION_FILES: ExtensionFile[] = [
  { path: EXTENSION_FILENAME, content: EXTENSION_SOURCE, mode: 0o644 },
];
