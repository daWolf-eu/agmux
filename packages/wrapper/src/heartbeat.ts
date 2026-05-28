import { HEARTBEAT_INTERVAL_MS } from "@agmux/protocol";
import type { HubClient } from "./hub-client.ts";
import { buildHeartbeatEvent } from "./lifecycle.ts";

export interface HeartbeatLoopArgs {
  client: HubClient;
  sessionId: string;
  host: string;
  pid: number;
  getWinsize: () => { rows: number; cols: number };
}

export function startHeartbeat(args: HeartbeatLoopArgs): () => void {
  const tick = async () => {
    const { rows, cols } = args.getWinsize();
    const ev = buildHeartbeatEvent({ sessionId: args.sessionId, host: args.host, pid: args.pid, rows, cols });
    await args.client.post(ev);
    await args.client.flushQueue();
  };
  const interval = setInterval(tick, HEARTBEAT_INTERVAL_MS);
  // fire one immediately so the projection gets an early heartbeat
  void tick();
  return () => clearInterval(interval);
}
