import { test, expect } from "bun:test";
import { mintSessionId, mintEventId } from "../src/ids.ts";

// The CLI's `agmux ls` displays slice(0, 23) of the session_id (e.g.
// "019e7022-2800-7000-a945"). UUIDv7 layout up to char 23:
//   chars 0-12  → ms timestamp (collides for sessions started in the same ms)
//   chars 14-17 → version nibble + rand_a (Bun seeds rand_a at 0 per process,
//                 so concurrent processes share these bits)
//   chars 19-22 → variant nibble + 14 bits of rand_b (truly random)
// 23 chars is the shortest prefix that crosses into rand_b — required to
// disambiguate sessions started from separate processes within the same ms.
const LS_PREFIX_LEN = 23;

test("mintSessionId returns a UUIDv7", () => {
  const id = mintSessionId();
  expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("mintEventId returns a 26-char ULID", () => {
  const id = mintEventId();
  expect(id).toHaveLength(26);
  expect(id).toMatch(/^[0-9A-Z]{26}$/);
});

test("ls-prefix is unique across rapid in-process mints", () => {
  const N = 1000;
  const prefixes = Array.from({ length: N }, () => mintSessionId().slice(0, LS_PREFIX_LEN));
  expect(new Set(prefixes).size).toBe(N);
});

test("ls-prefix is unique across concurrent processes", async () => {
  // Spawn separate processes (each with its own UUIDv7 counter) as
  // simultaneously as Promise.all allows. Regression guard for the bug where
  // `agmux ls` truncated session_id to 8 hex chars — the first 8 chars of a
  // UUIDv7 are the top 32 bits of the ms timestamp, which collide for IDs
  // minted within ~65 seconds of each other.
  const N = 8;
  const procs = Array.from({ length: N }, () =>
    Bun.spawn(["bun", "-e", "process.stdout.write(Bun.randomUUIDv7())"], { stdout: "pipe" }),
  );
  const ids = await Promise.all(procs.map((p) => new Response(p.stdout).text()));
  const prefixes = ids.map((id) => id.slice(0, LS_PREFIX_LEN));
  expect(new Set(prefixes).size).toBe(N);
});
