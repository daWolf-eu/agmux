import type { AgentKind } from "./session.ts";

export const TITLE_ACTIVITIES = ["working", "idle"] as const;
export type TitleActivity = (typeof TITLE_ACTIVITIES)[number];

export interface ParsedTitle {
  // null = the title says nothing reliable about activity.
  activity: TitleActivity | null;
  // The title with the status glyph stripped — for Claude that is the agent's
  // own generated session name.
  name: string;
}

// A leading braille frame + space: the one-character spinner Claude, Codex and
// pi prepend to the terminal title only while a turn is running (captured:
// claude "⠂ fix flaky tests", codex "⠇ refactor auth module"). Anchored so a
// braille character later in a title cannot false-positive.
const WORKING = /^[⠀-⣿] (.*)$/s;
// Claude replaces the spinner with "✳ " once the turn is over.
const CLAUDE_IDLE = /^✳ (.*)$/s;

// Classify an agent's terminal title. Only patterns verified against real
// titles are recognised; everything else is `activity: null`, which consumers
// treat as "no evidence" rather than as idle. Codex and pi retitle on work but
// have no verified idle marker, so for them only "working" is ever reported.
export function parseAgentTitle(kind: AgentKind, raw: string): ParsedTitle {
  const title = raw.trim();
  const w = WORKING.exec(title);
  if (w) return { activity: "working", name: w[1]!.trim() };
  if (kind === "claude") {
    const i = CLAUDE_IDLE.exec(title);
    if (i) return { activity: "idle", name: i[1]!.trim() };
  }
  return { activity: null, name: title };
}

export interface TitleSignalPayload {
  title: string;
  activity: TitleActivity | null;
}

// Turns a stream of raw title observations (every OSC title write, or one
// #{pane_title} poll per tick) into the few title.changed events worth sending:
// on a change of activity or name, and — while working — a keepalive every
// keepaliveMs so the hub's working timeout sees a long thinking-only turn as
// alive. Spinner frames change the raw title ~10x/s but never the parse, so
// they cost nothing. One instance per session; shared by the PTY wrapper and
// notifyd so both emit identical streams.
export class TitleSignal {
  private last: { activity: TitleActivity | null; name: string; at: number } | null = null;
  constructor(private readonly kind: AgentKind, private readonly keepaliveMs: number) {}

  observe(raw: string, nowMs: number): TitleSignalPayload | null {
    const p = parseAgentTitle(this.kind, raw);
    const prev = this.last;
    const changed = !prev || prev.activity !== p.activity || prev.name !== p.name;
    const keepalive = !changed && p.activity === "working" && nowMs - prev!.at >= this.keepaliveMs;
    if (!changed && !keepalive) return null;
    this.last = { activity: p.activity, name: p.name, at: nowMs };
    return { title: p.name, activity: p.activity };
  }
}
