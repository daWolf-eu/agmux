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
  /** session_id -> the attention_ts of the episode we last notified about.
   *  Bounded by live session count: pruned alongside `pending` when a session
   *  stops being notify-eligible. Keyed on the attention EPISODE rather than the
   *  trigger label, so a prompt->permission flip within one wait is still one wait. */
  fired: Map<string, string>;
}

export function createDetectState(): DetectState {
  return { pending: new Map(), fired: new Map() };
}

// A session's "attention identity": the same wait keeps one key, so a repeated
// poll cannot re-fire, while a genuinely new attention event re-arms.
//
// This MUST be attention_ts, not activity_ts. activity_ts also moves on every
// tool.used, and a session stays in `waiting`/`done` across tool calls (Claude's
// Stop hook does not fire while a subagent runs), so activity_ts minted a new episode per tool call and re-fired the same
// prompt on the next lull longer than delayMs — loudest under subagents, whose
// tool calls stream into the parent session for minutes. attention_ts moves only
// on input.required / turn.ended / session.ended, which is exactly one episode.
function episodeOf(r: SessionRow): string {
  return r.attention_ts ?? "";
}

function dedupKey(r: SessionRow, trigger: NotifyTrigger): string {
  return `${r.session_id}:${trigger}:${episodeOf(r)}`;
}

function triggerFor(r: SessionRow): NotifyTrigger | null {
  if (r.status === "ended" || r.status === "lost") return "session_end";
  if (r.status === "waiting") {
    const k = r.last_input_kind;
    if (k === "permission" || k === "confirm") return "permission";
    return "prompt";
  }
  // Only an UNSEEN finish notifies: once it is seen (you focused the pane, or
  // were already watching when it ended) it is `idle`, and a pending debounce
  // for it is pruned below instead of firing.
  if (r.status === "done") return "turn_end";
  return null;
}

/**
 * Establish a baseline from the first rows a daemon ever sees, so a restart
 * does not announce the whole board.
 *
 * Without this, an empty DetectState makes every already-eligible session look
 * like a brand-new transition on the first poll: come up with a dozen idle
 * sessions and you get a dozen "finished a turn" notifications for turns that
 * finished hours ago. Nothing is lost by staying quiet — everything already
 * waiting is on the status line, which renders the full board on that same
 * first tick.
 *
 * Only the episode observed here is silenced. A session that later moves to a
 * new attention_ts notifies normally, and a session not eligible at startup
 * (running, or not yet born) is never touched.
 */
export function primeDetectState(state: DetectState, rows: SessionRow[]): void {
  for (const row of rows) {
    if (!triggerFor(row)) continue;
    state.fired.set(row.session_id, episodeOf(row));
  }
}

export function detectNotifications(
  state: DetectState,
  rows: SessionRow[],
  cfg: DetectConfig,
  now: number,
): NotifyEvent[] {
  const out: NotifyEvent[] = [];
  const eligibleThisTick = new Set<string>();
  const presentThisTick = new Set<string>(rows.map((r) => r.session_id));

  for (const row of rows) {
    const trigger = triggerFor(row);
    if (!trigger) continue;
    eligibleThisTick.add(row.session_id);
    if (!cfg.triggers.includes(trigger)) continue;

    const episodeKey = episodeOf(row);
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

  // Prune pending for sessions that stopped wanting attention (ineligible). A session
  // that briefly flips to running is still present, so we only clean pending here.
  for (const id of [...state.pending.keys()]) {
    if (!eligibleThisTick.has(id)) {
      state.pending.delete(id);
    }
  }

  // Prune fired for sessions absent from the feed entirely. Presence is independent
  // of eligibility: a session can be running (not eligible) and still present (should
  // keep its fired entry so flicker within the same episode does not re-notify).
  for (const id of [...state.fired.keys()]) {
    if (!presentThisTick.has(id)) {
      state.fired.delete(id);
    }
  }

  return out;
}
