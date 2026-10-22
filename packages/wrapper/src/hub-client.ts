import * as fs from "node:fs";
import * as path from "node:path";
import type { EventEnvelope } from "@agmux/protocol";

export interface HubClientOpts {
  hubUrl: string;
  queueDir: string;
  sessionId: string;
  timeoutMs?: number;
  // Where the hub is now. The hub binds an ephemeral port, so `agmux hub restart`
  // moves it and the URL this session started with goes dead; on a failed send the
  // client asks once and keeps the answer if it works.
  resolveHubUrl?: () => string | null;
}

// The running local hub's URL, from the port file it writes (<stateDir>/hub.port).
export function portFileHubUrl(stateDir: string): string | null {
  try {
    const port = Number(fs.readFileSync(path.join(stateDir, "hub.port"), "utf8").trim());
    return Number.isInteger(port) && port > 0 ? `http://127.0.0.1:${port}` : null;
  } catch { return null; }
}

export class HubClient {
  private hubUrl: string;
  private queueDir: string;
  private sessionId: string;
  private timeoutMs: number;
  private resolveHubUrl: (() => string | null) | undefined;

  constructor(opts: HubClientOpts) {
    this.hubUrl = opts.hubUrl;
    this.queueDir = opts.queueDir;
    this.sessionId = opts.sessionId;
    this.timeoutMs = opts.timeoutMs ?? 2000;
    this.resolveHubUrl = opts.resolveHubUrl;
    fs.mkdirSync(this.queueDir, { recursive: true });
  }

  setHubUrl(u: string): void { this.hubUrl = u; }

  private get queueFile(): string {
    return path.join(this.queueDir, `${this.sessionId}.jsonl`);
  }

  // 2xx and 4xx (validation) both count as "delivered or unrecoverable"; only network/5xx fail.
  private async send(url: string, body: string, timeoutMs: number | null): Promise<boolean> {
    try {
      const ctrl = new AbortController();
      const t = timeoutMs === null ? null : setTimeout(() => ctrl.abort(), timeoutMs);
      const res = await fetch(`${url}/ingest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: ctrl.signal,
      });
      if (t) clearTimeout(t);
      return res.status < 500 && res.status !== 0;
    } catch {
      return false;
    }
  }

  // The current URL, then — if it failed — wherever the hub is now.
  private async sendFollowingHub(body: string, timeoutMs: number | null): Promise<boolean> {
    if (await this.send(this.hubUrl, body, timeoutMs)) return true;
    const fresh = this.resolveHubUrl?.();
    if (!fresh || fresh === this.hubUrl) return false;
    if (!(await this.send(fresh, body, timeoutMs))) return false;
    this.hubUrl = fresh;
    return true;
  }

  async post(ev: EventEnvelope): Promise<void> {
    if (!(await this.sendFollowingHub(JSON.stringify(ev), this.timeoutMs))) {
      fs.appendFileSync(this.queueFile, JSON.stringify(ev) + "\n");
    }
  }

  async flushQueue(): Promise<{ flushed: number }> {
    if (!fs.existsSync(this.queueFile)) return { flushed: 0 };
    const content = fs.readFileSync(this.queueFile, "utf8");
    const lines = content.split("\n").filter((l) => l.trim() !== "");
    const batch = lines.map((l) => JSON.parse(l));
    if (!(await this.sendFollowingHub(JSON.stringify(batch), null))) return { flushed: 0 };
    fs.unlinkSync(this.queueFile);
    return { flushed: lines.length };
  }
}
