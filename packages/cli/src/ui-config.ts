import { loadUiConfig } from "@agmux/wrapper";
import { setRemoteMark } from "@agmux/tui";

// [ui] for the verbs that draw sessions (ls, watch, dash, status line, notifyd,
// attach). A broken [ui] keeps the defaults; its message comes back so verbs that
// may print (not the status line) can warn. Other config errors are each verb's own.
export function applyUiConfig(configPath: string, load = loadUiConfig): string | null {
  try {
    const ui = load(configPath);
    if (ui.remoteMark) setRemoteMark(ui.remoteMark);
    return null;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return msg.startsWith("[ui]") ? msg : null;
  }
}
