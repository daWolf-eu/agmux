// Multi-tmux-server support: the socket path identifies which tmux server a
// session lives on. $TMUX (set inside any tmux pane) has the form
// "<socket-path>,<server-pid>,<session-id>"; its first comma-field is the
// absolute socket path. This is the single source available wherever we capture
// coords — including native-session enrichment, where we must know the server
// before we can query it. null = ambient/default server.
export function tmuxSocketFromEnv(tmux: string | null | undefined): string | null {
  if (!tmux) return null;
  const sock = tmux.split(",")[0];
  return sock && sock.length > 0 ? sock : null;
}

// Args that pin a tmux invocation to a specific server. `-S <socket>` must come
// before the tmux command word. Empty when socket is null/empty → the ambient
// (default) server, preserving prior behavior for sessions with no recorded socket.
export function tmuxSocketArgs(socket: string | null | undefined): string[] {
  return socket ? ["-S", socket] : [];
}
