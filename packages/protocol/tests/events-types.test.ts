import { test, expect } from "bun:test";
import { EVENT_KINDS_ADAPTER } from "../src/events.ts";
import type {
  IngestEnvelope, NativeIdentity, SessionRegisteredPayload, SessionLostPayload,
} from "../src/events.ts";
import type { SessionRow, SessionOrigin } from "../src/session.ts";

test("session.registered is an adapter event kind", () => {
  expect(EVENT_KINDS_ADAPTER).toContain("session.registered");
});

test("IngestEnvelope accepts the native identity form", () => {
  const id: NativeIdentity = { agent_kind: "claude", native_session_id: "n-1" };
  const ev: IngestEnvelope<SessionRegisteredPayload> = {
    event_id: "e1", ts: "2026-06-08T00:00:00.000Z", kind: "session.registered",
    version: 1, host: "h", identity: id, claim_session_id: null,
    payload: { native_session_id: "n-1", agent_kind: "claude", pid: 4242, cwd: "/tmp",
      tmux_session: null, tmux_window: null, tmux_pane: "%1", profile: null,
      agent_version: null, parent: null },
  };
  expect(ev.identity?.native_session_id).toBe("n-1");
});

test("IngestEnvelope accepts the canonical form (session_id)", () => {
  const ev: IngestEnvelope = {
    event_id: "e2", ts: "2026-06-08T00:00:00.000Z", kind: "turn.started",
    version: 1, host: "h", session_id: "sid-1", payload: {},
  };
  expect(ev.session_id).toBe("sid-1");
});

test("SessionLostPayload + SessionRow.origin compile", () => {
  const lost: SessionLostPayload = { reason: "pid_dead" };
  const origin: SessionOrigin = "native";
  const row = { origin } as Pick<SessionRow, "origin">;
  expect(lost.reason).toBe("pid_dead");
  expect(row.origin).toBe("native");
});

test("compaction is a known adapter event kind", () => {
  expect(EVENT_KINDS_ADAPTER).toContain("compaction");
});
