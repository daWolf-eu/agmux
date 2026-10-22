import { test, expect, beforeEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Store } from "@agmux/store";
import { createServer } from "@agmux/hub";
import { HubClient, portFileHubUrl } from "../src/hub-client.ts";

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agmux-hubclient-")); });

const ev = (overrides: Record<string, unknown> = {}) => ({
  event_id: `01HZ7P0K8WVQH8WGS8X9DC9F${Math.random().toString(36).slice(2, 4).toUpperCase()}A`,
  ts: "2026-05-28T12:00:00.000Z",
  session_id: "0190a3e0-0000-7000-8000-000000000000",
  kind: "session.heartbeat", version: 1, host: "test",
  payload: { pid_alive: true, winsize: { rows: 24, cols: 80 } },
  ...overrides,
});

test("post() to live hub succeeds and does not queue", async () => {
  const store = Store.openInMemory();
  const server = createServer({ store, port: 0 });
  const client = new HubClient({
    hubUrl: `http://${server.hostname}:${server.port}`,
    queueDir: tmp,
    sessionId: "0190a3e0-0000-7000-8000-000000000000",
  });
  await client.post(ev() as any);
  expect(store.listEvents()).toHaveLength(1);
  expect(fs.readdirSync(tmp)).toEqual([]);
  server.stop();
});

test("post() to dead hub falls through to JSONL queue", async () => {
  const client = new HubClient({
    hubUrl: "http://127.0.0.1:1",   // closed port
    queueDir: tmp,
    sessionId: "0190a3e0-0000-7000-8000-000000000000",
  });
  await client.post(ev() as any);
  const files = fs.readdirSync(tmp);
  expect(files).toHaveLength(1);
  const lines = fs.readFileSync(path.join(tmp, files[0]!), "utf8").trim().split("\n");
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0]!).kind).toBe("session.heartbeat");
});

test("flushQueue() drains the local file once hub recovers", async () => {
  const client = new HubClient({
    hubUrl: "http://127.0.0.1:1",
    queueDir: tmp,
    sessionId: "0190a3e0-0000-7000-8000-000000000000",
  });
  await client.post(ev() as any);
  await client.post(ev() as any);

  const store = Store.openInMemory();
  const server = createServer({ store, port: 0 });
  client.setHubUrl(`http://${server.hostname}:${server.port}`);
  const r = await client.flushQueue();
  expect(r.flushed).toBe(2);
  expect(fs.readdirSync(tmp)).toEqual([]);
  expect(store.listEvents()).toHaveLength(2);
  server.stop();
});

test("post() re-resolves a hub that moved to a new port and keeps using it", async () => {
  const store = Store.openInMemory();
  const server = createServer({ store, port: 0 });
  const live = `http://${server.hostname}:${server.port}`;
  let resolved = 0;
  const client = new HubClient({
    hubUrl: "http://127.0.0.1:1", // the port the hub had when the session started
    queueDir: tmp,
    sessionId: "0190a3e0-0000-7000-8000-000000000000",
    resolveHubUrl: () => { resolved++; return live; },
  });
  await client.post(ev() as any);
  await client.post(ev() as any);
  expect(store.listEvents()).toHaveLength(2);
  expect(fs.readdirSync(tmp)).toEqual([]);
  expect(resolved).toBe(1); // the second post goes straight to the live hub
  server.stop();
});

test("post() queues when the re-resolved hub is down too", async () => {
  const client = new HubClient({
    hubUrl: "http://127.0.0.1:1",
    queueDir: tmp,
    sessionId: "0190a3e0-0000-7000-8000-000000000000",
    resolveHubUrl: () => "http://127.0.0.1:2",
  });
  await client.post(ev() as any);
  expect(fs.readdirSync(tmp)).toHaveLength(1);
});

test("flushQueue() re-resolves a moved hub", async () => {
  const client = new HubClient({
    hubUrl: "http://127.0.0.1:1",
    queueDir: tmp,
    sessionId: "0190a3e0-0000-7000-8000-000000000000",
  });
  await client.post(ev() as any);

  const store = Store.openInMemory();
  const server = createServer({ store, port: 0 });
  const moved = new HubClient({
    hubUrl: "http://127.0.0.1:1",
    queueDir: tmp,
    sessionId: "0190a3e0-0000-7000-8000-000000000000",
    resolveHubUrl: () => `http://${server.hostname}:${server.port}`,
  });
  expect((await moved.flushQueue()).flushed).toBe(1);
  expect(store.listEvents()).toHaveLength(1);
  server.stop();
});

test("portFileHubUrl reads <stateDir>/hub.port", () => {
  expect(portFileHubUrl(tmp)).toBeNull();
  fs.writeFileSync(path.join(tmp, "hub.port"), "4242\n");
  expect(portFileHubUrl(tmp)).toBe("http://127.0.0.1:4242");
  fs.writeFileSync(path.join(tmp, "hub.port"), "junk\n");
  expect(portFileHubUrl(tmp)).toBeNull();
});
