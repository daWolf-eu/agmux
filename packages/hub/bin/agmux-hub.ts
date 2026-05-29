#!/usr/bin/env bun
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Store } from "@agmux/store";
import { createServer } from "../src/server.ts";
import { drainQueueDir } from "../src/drain.ts";
import { atomicWritePortFile, writePidFile, acquireSingletonLock } from "../src/bootstrap.ts";

const stateDir = path.join(os.homedir(), ".agmux");
fs.mkdirSync(path.join(stateDir, "queue"), { recursive: true });

const args = process.argv.slice(2);

if (args.includes("--rebuild-projections")) {
  const store = Store.open(path.join(stateDir, "agmux.sqlite"));
  store.rebuildProjections();
  console.log("projections rebuilt");
  process.exit(0);
}

// Single-instance guard: only one serving hub per state dir. If another live
// hub already holds the lock, defer to it and exit cleanly — the caller's
// ensureHubRunning will discover the existing hub via the shared port file.
const lock = acquireSingletonLock(path.join(stateDir, "hub.lock"));
if (!lock) {
  console.log("agmux-hub: another hub is already running; exiting");
  process.exit(0);
}

const store = Store.open(path.join(stateDir, "agmux.sqlite"));
const server = createServer({ store, port: 0 });
const drainRes = drainQueueDir(path.join(stateDir, "queue"), store);
if (drainRes.eventsIngested > 0) {
  console.log(`drained ${drainRes.eventsIngested} events from ${drainRes.filesDrained} file(s)`);
}

atomicWritePortFile(path.join(stateDir, "hub.port"), server.port!);
writePidFile(path.join(stateDir, "hub.pid"), process.pid);

console.log(`agmux-hub listening on http://${server.hostname}:${server.port}`);

const shutdown = () => {
  try { fs.unlinkSync(path.join(stateDir, "hub.pid")); } catch {}
  try { fs.unlinkSync(path.join(stateDir, "hub.port")); } catch {}
  lock.release();
  server.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
