import type { SessionRow } from "@agmux/protocol";

export type NotifyTrigger = "permission" | "prompt" | "turn_end" | "session_end";

export interface DetectConfig {
  delayMs: number;
  triggers: NotifyTrigger[];
}

export interface NotifyEvent {
  session_id: string;
  trigger: NotifyTrigger;
  row: SessionRow;
}

export interface DetectState {
  /** session_id → { key, since } for a wait that has not yet fired. */
  pending: Map<string, { key: string; since: number; trigger: NotifyTrigger }>;
  /** session_id -> the activity_ts of the episode we last notified about.
   *  Bounded by live session count: pruned alongside `pending` when a session
   *  stops being notify-eligible. Keyed on the attention EPISODE rather than the
   *  trigger label, so a prompt->permission flip within one wait is still one wait. */
  fired: Map<string, string>;
}

export function createDetectState(): DetectState {
  return { pending: new Map(), fired: new Map() };
}

// A session's "attention identity": the same wait keeps one key, so a repeated
// poll cannot re-fire, while a genuinely new event (new activity_ts) re-arms.
function dedupKey(r: SessionRow, trigger: NotifyTrigger): string {
  return `${r.session_id}:${trigger}:${r.activity_ts ?? ""}`;
}

function triggerFor(r: SessionRow): NotifyTrigger | null {
  if (r.status === "ended" || r.status === "lost") return "session_end";
  if (r.status === "waiting") {
    const k = r.last_input_kind;
    if (k === "permission" || k === "confirm") return "permission";
    return "prompt";
  }
  if (r.status === "idle") return "turn_end";
  return null;
}

export function detectNotifications(
  state: DetectState,
  rows: SessionRow[],
  cfg: DetectConfig,
  now: number,
): NotifyEvent[] {
  const out: NotifyEvent[] = [];
  const seenThisTick = new Set<string>();

  for (const row of rows) {
    const trigger = triggerFor(row);
    if (!trigger) continue;
    seenThisTick.add(row.session_id);
    if (!cfg.triggers.includes(trigger)) continue;

    const episodeKey = row.activity_ts ?? "";
    if (state.fired.get(row.session_id) === episodeKey) continue;

    // A terminal session is not "waiting" for anything — debouncing it would only
    // delay news that is already final.
    const immediate = trigger === "session_end" || cfg.delayMs === 0;

    const key = dedupKey(row, trigger);
    const prev = state.pending.get(row.session_id);
    if (!prev || prev.key !== key) {
      state.pending.set(row.session_id, { key, since: now, trigger });
      if (!immediate) continue;
    }

    const since = immediate ? now : state.pending.get(row.session_id)!.since;
    if (immediate || now - since >= cfg.delayMs) {
      state.fired.set(row.session_id, episodeKey);
      state.pending.delete(row.session_id);
      out.push({ session_id: row.session_id, trigger, row });
    }
  }

  // A session that stopped wanting attention drops its pending timer, so a later
  // wait starts its debounce fresh rather than inheriting an old clock.
  // Also prune fired entries so they're bounded by live sessions.
  for (const id of [...state.pending.keys()]) {
    if (!seenThisTick.has(id)) {
      state.pending.delete(id);
      state.fired.delete(id);
    }
  }
  for (const id of [...state.fired.keys()]) {
    if (!seenThisTick.has(id)) state.fired.delete(id);
  }
  return out;
}
