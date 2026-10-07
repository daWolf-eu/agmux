import { test, expect } from "bun:test";
import { postSeen, seenCmd } from "../src/seen.ts";

test("posts a session.seen envelope to /ingest", async () => {
  let body: any = null;
  const ok = await postSeen("agx-1", "attach", {
    hubUrl: "http://h", host: "box",
    fetchImpl: (async (_u: any, init: any) => { body = JSON.parse(init.body); return new Response(null, { status: 202 }); }) as unknown as typeof fetch,
    now: () => "2026-09-11T10:00:00.000Z",
    newId: () => "evt-1",
  });
  expect(ok).toBe(true);
  expect(body[0].kind).toBe("session.seen");
  expect(body[0].session_id).toBe("agx-1");
  expect(body[0].payload).toEqual({ source: "attach" });
});

test("a hub failure returns false instead of throwing — attach must still proceed", async () => {
  const ok = await postSeen("agx-1", "attach", {
    hubUrl: "http://h", host: "box",
    fetchImpl: (async () => { throw new Error("refused"); }) as unknown as typeof fetch,
    now: () => "t", newId: () => "e",
  });
  expect(ok).toBe(false);
});

test("seenCmd posts a dismiss-sourced event for an explicit id", async () => {
  let body: any = null;
  const code = await seenCmd(
    { idOrPrefix: "agx-1", hubUrl: "http://h", host: "box" },
    {
      fetchImpl: (async (_u: any, init: any) => { body = JSON.parse(init.body); return new Response(null, { status: 202 }); }) as unknown as typeof fetch,
      now: () => "t", newId: () => "e",
    },
  );
  expect(code).toBe(0);
  expect(body[0].payload).toEqual({ source: "dismiss" });
});

test("seenCmd resolves --pane to the session owning that tmux pane", async () => {
  const calls: string[] = [];
  const fetchImpl = (async (u: any, init?: any) => {
    calls.push(String(u));
    if (String(u).includes("/sessions?status=open")) {
      return new Response(JSON.stringify({
        sessions: [
          { session_id: "other", tmux_pane: "%1", status: "done" },
          { session_id: "agx-2", tmux_pane: "%42", status: "done" },
        ],
      }));
    }
    calls.push(String(init?.body ?? ""));
    return new Response(null, { status: 202 });
  }) as unknown as typeof fetch;

  const code = await seenCmd(
    { pane: "%42", source: "focus", hubUrl: "http://h", host: "box" },
    { fetchImpl, now: () => "t", newId: () => "e" },
  );
  expect(code).toBe(0);
  expect(calls.some((u) => u.includes("/sessions?status=open"))).toBe(true);
  expect(calls.some((u) => u.includes("/ingest"))).toBe(true);
  const body = JSON.parse(calls[calls.length - 1]!);
  expect(body[0].session_id).toBe("agx-2");
  expect(body[0].payload).toEqual({ source: "focus" });
});

test("seenCmd --pane posts nothing unless the owning session is done", async () => {
  for (const status of ["idle", "running", "waiting"]) {
    let ingestCalled = false;
    const fetchImpl = (async (u: any) => {
      if (String(u).includes("/sessions?status=open")) {
        return new Response(JSON.stringify({ sessions: [{ session_id: "a", tmux_pane: "%42", status }] }));
      }
      ingestCalled = true;
      return new Response(null, { status: 202 });
    }) as unknown as typeof fetch;
    const code = await seenCmd({ pane: "%42", hubUrl: "http://h", host: "box" }, { fetchImpl, now: () => "t", newId: () => "e" });
    expect(code).toBe(0);
    expect(ingestCalled).toBe(false);
  }
});

test("seenCmd --socket ignores a same-numbered pane on another tmux server", async () => {
  const posted: string[] = [];
  const fetchImpl = (async (u: any, init?: any) => {
    if (String(u).includes("/sessions?status=open")) {
      return new Response(JSON.stringify({ sessions: [
        { session_id: "elsewhere", tmux_pane: "%42", tmux_socket: "/tmp/other", status: "done" },
        { session_id: "here", tmux_pane: "%42", tmux_socket: "/tmp/mine", status: "done" },
      ] }));
    }
    posted.push(JSON.parse(String(init.body))[0].session_id);
    return new Response(null, { status: 202 });
  }) as unknown as typeof fetch;
  await seenCmd({ pane: "%42", socket: "/tmp/mine", hubUrl: "http://h", host: "box" }, { fetchImpl, now: () => "t", newId: () => "e" });
  expect(posted).toEqual(["here"]);
});

test("seenCmd on a pane no session owns exits 0 without posting anything", async () => {
  let ingestCalled = false;
  const fetchImpl = (async (u: any) => {
    if (String(u).includes("/sessions?status=open")) {
      return new Response(JSON.stringify({ sessions: [{ session_id: "other", tmux_pane: "%1" }] }));
    }
    ingestCalled = true;
    return new Response(null, { status: 202 });
  }) as unknown as typeof fetch;

  const code = await seenCmd(
    { pane: "%999", hubUrl: "http://h", host: "box" },
    { fetchImpl, now: () => "t", newId: () => "e" },
  );
  expect(code).toBe(0);
  expect(ingestCalled).toBe(false);
});

test("seenCmd with neither an id nor a pane is an error", async () => {
  const code = await seenCmd(
    { hubUrl: "http://h", host: "box" },
    { fetchImpl: (async () => new Response(null, { status: 202 })) as unknown as typeof fetch, now: () => "t", newId: () => "e" },
  );
  expect(code).toBe(2);
});
