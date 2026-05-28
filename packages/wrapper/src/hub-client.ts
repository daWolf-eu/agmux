import * as fs from "node:fs";
import * as path from "node:path";
import type { EventEnvelope } from "@agmux/protocol";

export interface HubClientOpts {
  hubUrl: string;
  queueDir: string;
  sessionId: string;
  timeoutMs?: number;
}

export class HubClient {
  private hubUrl: string;
  private queueDir: string;
  private sessionId: string;
  private timeoutMs: number;

  constructor(opts: HubClientOpts) {
    this.hubUrl = opts.hubUrl;
    this.queueDir = opts.queueDir;
    this.sessionId = opts.sessionId;
    this.timeoutMs = opts.timeoutMs ?? 2000;
    fs.mkdirSync(this.queueDir, { recursive: true });
  }

  setHubUrl(u: string): void { this.hubUrl = u; }

  private get queueFile(): string {
    return path.join(this.queueDir, `${this.sessionId}.jsonl`);
  }

  async post(ev: EventEnvelope): Promise<void> {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
      const res = await fetch(`${this.hubUrl}/ingest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(ev),
        signal: ctrl.signal,
      });
      clearTimeout(t);
      if (res.status >= 500 || res.status === 0) throw new Error(`status ${res.status}`);
      // 2xx and 4xx (validation) both count as "delivered or unrecoverable"; only network/5xx queue.
    } catch {
      fs.appendFileSync(this.queueFile, JSON.stringify(ev) + "\n");
    }
  }

  async flushQueue(): Promise<{ flushed: number }> {
    if (!fs.existsSync(this.queueFile)) return { flushed: 0 };
    const content = fs.readFileSync(this.queueFile, "utf8");
    const lines = content.split("\n").filter((l) => l.trim() !== "");
    const batch = lines.map((l) => JSON.parse(l));
    try {
      const res = await fetch(`${this.hubUrl}/ingest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(batch),
      });
      if (res.status >= 500) throw new Error(`status ${res.status}`);
      fs.unlinkSync(this.queueFile);
      return { flushed: lines.length };
    } catch {
      return { flushed: 0 };
    }
  }
}
