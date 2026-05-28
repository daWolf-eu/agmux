import { test, expect, beforeEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Store } from "@agmux/store";
import { createServer } from "@agmux/hub";
import { discoverLiveHub } from "../src/hub-spawn.ts";

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agmux-discover-")); });

test("discoverLiveHub returns null when pid+port files missing", async () => {
  const r = await discoverLiveHub(tmp);
  expect(r).toBeNull();
});

test("discoverLiveHub returns the URL when a real hub is serving on the port", async () => {
  const store = Store.openInMemory();
  const server = createServer({ store, port: 0 });
  fs.writeFileSync(path.join(tmp, "hub.port"), String(server.port));
  fs.writeFileSync(path.join(tmp, "hub.pid"), String(process.pid));
  const r = await discoverLiveHub(tmp);
  expect(r).toBe(`http://127.0.0.1:${server.port}`);
  server.stop();
});

test("discoverLiveHub returns null when port file points at nothing", async () => {
  fs.writeFileSync(path.join(tmp, "hub.port"), "1");
  fs.writeFileSync(path.join(tmp, "hub.pid"), String(process.pid));
  const r = await discoverLiveHub(tmp);
  expect(r).toBeNull();
});
