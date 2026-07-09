import type { SessionRow } from "@agmux/protocol";

export interface YankField {
  label: string;
  value: string;
  empty: boolean;
}

// tmux target as shown in the detail pane: "" when there is no tmux session,
// otherwise "session:window" plus " pane" when a pane is recorded. Shared with
// PreviewPane's DetailBody so "what you see is what you yank".
export function tmuxTarget(row: SessionRow): string {
  if (!row.tmux_session || !row.tmux_window) return "";
  return `${row.tmux_session}:${row.tmux_window}${row.tmux_pane ? ` ${row.tmux_pane}` : ""}`;
}

// The 10 most-copied fields, in a FIXED order so digit shortcuts are stable.
// Values are pure SessionRow projections (never the async usage buffer). A field
// is `empty` when its value trims to "" — empty fields keep their slot but are
// dimmed and non-copyable in the popup.
export function yankFields(row: SessionRow): YankField[] {
  const raw: [string, string][] = [
    ["Session ID", row.session_id],
    ["Native ID", row.native_session_id ?? ""],
    ["CWD", row.cwd],
    ["Command", [row.command, ...row.args].join(" ")],
    ["Project", row.project ?? ""],
    ["TMUX", tmuxTarget(row)],
    ["PID", row.pid == null ? "" : String(row.pid)],
    ["Host", row.host],
    ["Profile", row.profile ?? ""],
    ["Parent ID", row.parent_session_id ?? ""],
  ];
  return raw.map(([label, value]) => ({ label, value, empty: value.trim() === "" }));
}
