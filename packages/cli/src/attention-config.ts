import * as fs from "node:fs";
import { parse as parseToml } from "smol-toml";

export const NOTIFY_TRIGGERS = ["permission", "prompt", "turn_end", "session_end"] as const;
export type NotifyTrigger = (typeof NOTIFY_TRIGGERS)[number];

export const SHOW_MODES = ["all", "attention", "done", "waiting"] as const;
export type ShowMode = (typeof SHOW_MODES)[number];

export const POSITIONS = ["status2", "status-right", "off"] as const;
export type Position = (typeof POSITIONS)[number];

export interface NotifyConfig {
  enabled: boolean;
  delayMs: number;
  triggers: NotifyTrigger[];
  sound: boolean;
  soundName: string;
  sounds: Partial<Record<NotifyTrigger, string>>;
  command: string;
  tmuxMessage: boolean;
  suppressWhenVisible: boolean;
}

export interface StatuslineConfig {
  enabled: boolean;
  position: Position;
  show: ShowMode;
  max: number;
  format: string;
  sort: "started" | "activity";
}

export interface AttentionConfig { notify: NotifyConfig; statusline: StatuslineConfig; }

// "5s" | "2m" | 30 (bare = seconds). Throws on anything else: silently falling
// back to 0 would turn the debounce off without telling anyone.
export function parseDuration(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v) && v >= 0) return Math.round(v * 1000);
  if (typeof v === "string") {
    const m = /^(\d+(?:\.\d+)?)(ms|s|m)?$/.exec(v.trim());
    if (m) {
      const n = Number(m[1]);
      const unit = m[2] ?? "s";
      const mult = unit === "ms" ? 1 : unit === "m" ? 60000 : 1000;
      return Math.round(n * mult);
    }
  }
  throw new Error(`invalid duration: ${JSON.stringify(v)} (expected "5s", "2m", or a number of seconds)`);
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string, fallback: T): T {
  if (value === undefined) return fallback;
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T;
  throw new Error(`invalid ${field}: ${String(value)} (expected one of ${allowed.join(", ")})`);
}

function positiveInt(value: unknown, field: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  throw new Error(`invalid ${field}: ${String(value)} (expected a positive integer)`);
}

function bool(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value === "boolean") return value;
  throw new Error(`invalid ${field}: ${String(value)} (expected a boolean)`);
}

function str(value: unknown, field: string, fallback: string): string {
  if (value === undefined) return fallback;
  if (typeof value === "string" && value.length > 0) return value;
  throw new Error(`invalid ${field}: ${String(value)} (expected a string)`);
}

export function loadAttentionConfig(toml: string): AttentionConfig {
  const raw = (toml.trim() === "" ? {} : parseToml(toml)) as any;
  const n = (raw.notify ?? {}) as any;
  const s = (raw.statusline ?? {}) as any;

  const triggers: NotifyTrigger[] = Array.isArray(n.triggers)
    ? n.triggers.map((t: unknown) => oneOf(t, NOTIFY_TRIGGERS, "notify.triggers entry", "permission"))
    : [...NOTIFY_TRIGGERS];

  const sounds: Partial<Record<NotifyTrigger, string>> = {};
  for (const [k, v] of Object.entries((n.sounds ?? {}) as Record<string, unknown>)) {
    sounds[oneOf(k, NOTIFY_TRIGGERS, "notify.sounds key", "permission")] = str(v, `notify.sounds.${k}`, "");
  }

  return {
    notify: {
      enabled: bool(n.enabled, "notify.enabled", true),
      delayMs: n.delay === undefined ? 5000 : parseDuration(n.delay),
      triggers,
      sound: bool(n.sound, "notify.sound", true),
      soundName: str(n.sound_name, "notify.sound_name", "Ping"),
      sounds,
      command: str(n.command, "notify.command", "auto"),
      tmuxMessage: bool(n.tmux_message, "notify.tmux_message", true),
      suppressWhenVisible: bool(n.suppress_when_visible, "notify.suppress_when_visible", true),
    },
    statusline: {
      enabled: bool(s.enabled, "statusline.enabled", false),
      position: oneOf(s.position, POSITIONS, "statusline.position", "status2"),
      // "unread" predates `done` being a status; it meant exactly that.
      show: oneOf(s.show === "unread" ? "done" : s.show, SHOW_MODES, "statusline.show", "all"),
      max: positiveInt(s.max, "statusline.max", 6),
      format: str(s.format, "statusline.format", "{glyph} {tmux_session}:{tmux_pane}"),
      sort: oneOf(s.sort, ["started", "activity"] as const, "statusline.sort", "activity"),
    },
  };
}

// Thin IO wrapper: reads the config file (missing file → "") and hands the raw
// TOML text to the pure loadAttentionConfig above. Kept separate so the parser
// stays pure and testable without touching the filesystem.
export function loadAttentionConfigFile(configPath: string): AttentionConfig {
  const toml = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "";
  return loadAttentionConfig(toml);
}
