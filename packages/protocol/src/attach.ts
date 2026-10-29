// Where `agmux attach --placement` / the dash `A` popup opens a session. The
// order IS the popup's fixed digit slots (1–7): never reorder, only append.
export const ATTACH_PLACEMENTS = [
  "inline", "new-pane", "new-window", "new-session", "peek", "new-tab", "new-terminal",
] as const;
export type AttachPlacement = (typeof ATTACH_PLACEMENTS)[number];

export function isAttachPlacement(v: unknown): v is AttachPlacement {
  return typeof v === "string" && (ATTACH_PLACEMENTS as readonly string[]).includes(v);
}

// How a remote (sandbox) session is attached: a throwaway tmux view session on
// the sandbox's tmux, or the sandbox's own client (full) driving its window.
export const REMOTE_ATTACH_MODES = ["view", "full"] as const;
export type RemoteAttachMode = (typeof REMOTE_ATTACH_MODES)[number];

export function isRemoteAttachMode(v: unknown): v is RemoteAttachMode {
  return typeof v === "string" && (REMOTE_ATTACH_MODES as readonly string[]).includes(v);
}

// Values from a replicated row (or config) reach a sandbox shell as positional
// args; they are validated against these before any use.
export function isAttachTag(s: string): boolean {
  return /^[A-Za-z0-9_-]{1,32}$/.test(s);
}

export function isTmuxKeyName(s: string): boolean {
  return /^[A-Za-z0-9-]{1,16}$/.test(s);
}

// A remote row's tmux coordinates (SessionRow.remote_tmux).
export interface RemoteTmux {
  session: string;
  window: string;
  pane: string | null;
  socket: string | null;
  // tmux server identity "<pid>-<start_time>" (or "<pid>"): tells a restarted
  // server (same socket path, window ids reset to @0) from the one recorded.
  server?: string | null;
}

// tmux format whose output is a server id (see isTmuxServerId).
export const TMUX_SERVER_ID_FMT = "#{pid}-#{start_time}";

export function isTmuxServerId(s: string): boolean {
  return /^\d{1,10}(-\d{1,12})?$/.test(s);
}

export function isRemoteTmux(v: unknown): v is RemoteTmux {
  if (typeof v !== "object" || v === null) return false;
  const t = v as Record<string, unknown>;
  const { session, window, pane, socket, server } = t;
  return typeof session === "string" && session.length >= 1 && session.length <= 128 &&
    !/[\x00-\x1f\x7f:.]/.test(session) &&
    typeof window === "string" && /^@\d{1,9}$/.test(window) &&
    (pane === null || (typeof pane === "string" && /^%\d{1,9}$/.test(pane))) &&
    (socket === null || (typeof socket === "string" && /^\/[A-Za-z0-9._/-]{1,255}$/.test(socket))) &&
    (server == null || (typeof server === "string" && isTmuxServerId(server)));
}
