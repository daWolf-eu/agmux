import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeLineAtomic, isStale } from "../src/notifyd.ts";

test("writes via a temp file then renames, so a reader never sees a partial line", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agmux-sl-"));
  const target = path.join(dir, "nested", "statusline");
  const seen: string[] = [];
  writeLineAtomic(target, "hello", {
    mkdir: (d) => { seen.push(`mkdir:${d}`); fs.mkdirSync(d, { recursive: true }); },
    write: (f, t) => { seen.push(`write:${path.basename(f)}`); fs.writeFileSync(f, t); },
    rename: (a, b) => { seen.push("rename"); fs.renameSync(a, b); },
  });
  expect(seen[0]).toContain("mkdir:");
  expect(seen[1]).toContain("write:statusline.");   // temp sibling, not the target
  expect(seen[2]).toBe("rename");
  expect(fs.readFileSync(target, "utf8")).toBe("hello");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a write failure is swallowed — the daemon must not die over a cache file", () => {
  expect(() => writeLineAtomic("/nope/x", "hi", {
    mkdir: () => { throw new Error("EACCES"); },
    write: () => {}, rename: () => {},
  })).not.toThrow();
});

test("heartbeat staleness is judged against the configured interval", () => {
  const t0 = Date.parse("2026-09-11T10:00:00.000Z");
  expect(isStale("2026-09-11T10:00:02.000Z", t0 + 3000, 1000)).toBe(false);
  expect(isStale("2026-09-11T10:00:00.000Z", t0 + 30000, 1000)).toBe(true);
  expect(isStale(null, t0, 1000)).toBe(true);
  expect(isStale("not-a-date", t0, 1000)).toBe(true);
});
