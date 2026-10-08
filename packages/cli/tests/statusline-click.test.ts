import { test, expect } from "bun:test";
import { FILTER_TOKEN, chipToken } from "@agmux/tui";
import { statuslineClick } from "../src/statusline-click.ts";

function recorder() {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      attach: async (id: string) => { calls.push(`attach ${id}`); return 0; },
      seen: async (o: { idOrPrefix?: string }) => { calls.push(`seen ${o.idOrPrefix}`); return 0; },
      cycleShow: async (step: 1 | -1) => { calls.push(`cycle ${step}`); return 0; },
    },
  };
}

const ID = "0198abcd-1234-7aaa-bbbb-cccccccccccc";

test("left click on a chip switches to its session (attach marks it seen)", async () => {
  const r = recorder();
  expect(await statuslineClick("left", chipToken(ID), r.deps)).toBe(0);
  expect(r.calls).toEqual(["attach 0198abcd-1234-"]);
});

test("right click on a chip only marks it seen", async () => {
  const r = recorder();
  await statuslineClick("right", chipToken(ID), r.deps);
  expect(r.calls).toEqual(["seen 0198abcd-1234-"]);
});

test("the filter chip cycles the show mode: left forward, right back", async () => {
  const r = recorder();
  await statuslineClick("left", FILTER_TOKEN, r.deps);
  await statuslineClick("right", FILTER_TOKEN, r.deps);
  expect(r.calls).toEqual(["cycle 1", "cycle -1"]);
});

test("a range that isn't ours is a no-op", async () => {
  const r = recorder();
  for (const t of ["window", "left", "", "my-range"]) expect(await statuslineClick("left", t, r.deps)).toBe(0);
  expect(r.calls).toEqual([]);
});
