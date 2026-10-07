import * as fs from "node:fs";
import type { SessionName } from "../../core/types.ts";

// How much of the transcript tail to scan. Claude re-appends its title records
// as the session goes on, so the latest ones sit near the end.
const TAIL_BYTES = 4 * 1024 * 1024;

// Claude keeps the session's name in its transcript JSONL:
//   {"type":"custom-title","customTitle":"…"}  — the user's /rename
//   {"type":"ai-title","aiTitle":"…"}          — Claude's own generated title
// The latest of each wins; a rename beats the generated title.
export function claudeSessionName(raw: unknown): SessionName | null {
  const p = (raw ?? {}) as { transcript_path?: unknown };
  if (typeof p.transcript_path !== "string") return null;
  let text: string;
  try {
    const fd = fs.openSync(p.transcript_path, "r");
    try {
      const size = fs.fstatSync(fd).size;
      const len = Math.min(size, TAIL_BYTES);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      text = buf.toString("utf8");
    } finally { fs.closeSync(fd); }
  } catch { return null; }

  let user: string | null = null;
  let agent: string | null = null;
  for (const line of text.split("\n")) {
    // Cheap prefilter: JSON.parse only the few title lines.
    if (!line.includes("-title\"")) continue;
    let rec: any;
    try { rec = JSON.parse(line); } catch { continue; } // incl. a cut first line
    if (rec?.type === "custom-title" && typeof rec.customTitle === "string" && rec.customTitle.trim()) user = rec.customTitle.trim();
    else if (rec?.type === "ai-title" && typeof rec.aiTitle === "string" && rec.aiTitle.trim()) agent = rec.aiTitle.trim();
  }
  if (user) return { name: user, source: "user" };
  if (agent) return { name: agent, source: "agent" };
  return null;
}
