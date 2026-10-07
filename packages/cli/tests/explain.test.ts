import { test, expect } from "bun:test";
import type { StatusDecision } from "@agmux/protocol";
import { explainCmd, formatDecision } from "../src/explain.ts";

const decision: StatusDecision = {
  session_id: "agx-1", status: "done", stored_status: "idle", rule: "unseen",
  reason: "attention at 2026-01-01T00:00:10.000Z is newer than seen at 2026-01-01T00:00:00.000Z",
  status_event: { kind: "turn.ended", ts: "2026-01-01T00:00:10.000Z" },
  attention: { kind: "turn.ended", ts: "2026-01-01T00:00:10.000Z" },
  seen: { source: "prompt", ts: "2026-01-01T00:00:00.000Z" },
  title: { title: "fix tests", activity: "idle", ts: "2026-01-01T00:00:11.000Z" },
  meta: { name: "Fix flaky tests", name_source: "agent", git_repo: "agmux", git_branch: "fix/e2e", git_root: "/src/agmux" },
  last_input_kind: null, last_tool: null, last_work_ts: "2026-01-01T00:00:11.000Z",
  now: "2026-01-01T00:00:20.000Z",
};

test("formatDecision leads with the status and why", () => {
  const out = formatDecision(decision);
  expect(out).toContain("status    done (stored: idle)");
  expect(out).toContain("set by    turn.ended at 2026-01-01T00:00:10.000Z (10s ago)");
  expect(out).toContain("seen      prompt at 2026-01-01T00:00:00.000Z (20s ago)");
  expect(out).toContain('title     "fix tests" → idle');
  expect(out).toContain('name      "Fix flaky tests" (agent)');
  expect(out).toContain("git       agmux @ fix/e2e (/src/agmux)");
});

test("explainCmd resolves a prefix and fetches the decision", async () => {
  const urls: string[] = [];
  const fetchImpl = (async (u: any) => {
    urls.push(String(u));
    if (String(u).includes("/explain")) return new Response(JSON.stringify({ decision }));
    return new Response(JSON.stringify({ sessions: [{ session_id: "agx-1" }, { session_id: "bbb" }] }));
  }) as unknown as typeof fetch;
  const out: string[] = [];
  const code = await explainCmd({ idOrPrefix: "agx", json: true, hubUrl: "http://h" }, { fetchImpl, out: (s) => out.push(s), err: () => {} });
  expect(code).toBe(0);
  expect(urls).toContain("http://h/sessions/agx-1/explain");
  expect(JSON.parse(out[0]!).rule).toBe("unseen");
});

test("explainCmd on an unknown prefix exits 2", async () => {
  const fetchImpl = (async () => new Response(JSON.stringify({ sessions: [] }))) as unknown as typeof fetch;
  const errs: string[] = [];
  expect(await explainCmd({ idOrPrefix: "zzz", hubUrl: "http://h" }, { fetchImpl, out: () => {}, err: (s) => errs.push(s) })).toBe(2);
  expect(errs[0]).toContain("no session matches");
});
