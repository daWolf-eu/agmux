import type { SessionRow, EventEnvelope } from "@agmux/protocol";

export type PreviewMode = "mirror" | "events" | "detail";

// Minimal usage shape the detail card needs; the cli maps the hub's usage row
// into this so tui stays free of @agmux/store types.
export interface UsageSummary {
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  last_model: string | null;
  turn_count: number;
}

// A terminal hand-off: a command the entry point runs AFTER ink unmounts and the
// alt-screen is restored (for not-in-tmux attach and for resume/relaunch).
export interface Handoff {
  argv: string[];
  env?: Record<string, string>;
}

// Side-effecting preview data sources; concrete impls live in cli.
export interface PreviewSource {
  mirror(row: SessionRow): Promise<string>;       // tmux capture-pane text ("" if unavailable)
  events(row: SessionRow): Promise<EventEnvelope[]>;
  usage(row: SessionRow): Promise<UsageSummary | null>;
}

// Mutating actions; concrete impls live in cli (reuse attach/kill/relaunch).
// attach/resume return a Handoff when the terminal must be handed off, or null
// when handled inline (e.g. in-tmux switch-client — the TUI stays alive).
export interface Actions {
  attach(row: SessionRow): Promise<Handoff | null>;
  kill(row: SessionRow): Promise<void>;
  resume(row: SessionRow): Promise<Handoff>;
}
