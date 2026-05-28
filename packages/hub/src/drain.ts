import * as fs from "node:fs";
import * as path from "node:path";
import type { Store } from "@agmux/store";
import { validateEnvelope } from "@agmux/protocol";

export interface DrainResult { filesDrained: number; eventsIngested: number; linesSkipped: number; }

export function drainQueueDir(dir: string, store: Store): DrainResult {
  const r: DrainResult = { filesDrained: 0, eventsIngested: 0, linesSkipped: 0 };
  if (!fs.existsSync(dir)) return r;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".jsonl")) continue;
    const full = path.join(dir, name);
    const content = fs.readFileSync(full, "utf8");
    for (const line of content.split("\n")) {
      if (line.trim() === "") continue;
      let parsed: unknown;
      try { parsed = JSON.parse(line); } catch { r.linesSkipped++; continue; }
      const v = validateEnvelope(parsed);
      if (!v.ok) { r.linesSkipped++; continue; }
      store.append(parsed as any); // idempotent by event_id
      r.eventsIngested++;
    }
    fs.unlinkSync(full);
    r.filesDrained++;
  }
  return r;
}
