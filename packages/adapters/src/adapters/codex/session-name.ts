import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SessionName } from "../../core/types.ts";

// Codex names threads in $CODEX_HOME/session_index.jsonl, one line per naming:
//   {"id":"<thread id>","thread_name":"…","updated_at":"…"}
// The thread id is the hook's session_id; the last line for it wins. The
// first prompt (state DB threads.title) is deliberately not used as a name.
export function codexSessionName(raw: unknown, env: Record<string, string | undefined>): SessionName | null {
  const sid = (raw as { session_id?: unknown } | null)?.session_id;
  if (typeof sid !== "string" || sid === "") return null;
  const home = env.CODEX_HOME || path.join(os.homedir(), ".codex");
  let text: string;
  try { text = fs.readFileSync(path.join(home, "session_index.jsonl"), "utf8"); } catch { return null; }
  let name: string | null = null;
  for (const line of text.split("\n")) {
    if (!line.includes(sid)) continue;
    let rec: any;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec?.id === sid && typeof rec.thread_name === "string" && rec.thread_name.trim()) name = rec.thread_name.trim();
  }
  return name ? { name, source: "agent" } : null;
}
