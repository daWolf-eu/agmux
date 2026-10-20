import { test, expect } from "bun:test";
import { inspectCmd } from "../src/inspect.ts";

const ID = "11111111-1111-1111-1111-111111111111";
const host = { host: "gw/sb", remote: "sb1", last_sync_ok: true, cursor: 1 };

function fake(remote: boolean | undefined, hosts: unknown[]): typeof fetch {
  return (async (url: string) => {
    const u = String(url);
    if (u.includes("/sessions?")) return new Response(JSON.stringify({ sessions: [{ session_id: ID }] }));
    if (u.includes("/hosts")) return new Response(JSON.stringify({ hosts }));
    return new Response(JSON.stringify({ session: { session_id: ID, host: "gw/sb", remote }, events: [] }));
  }) as unknown as typeof fetch;
}
async function run(remote: boolean | undefined, hosts: unknown[]) {
  const out: string[] = [];
  const code = await inspectCmd({ idOrPrefix: "1111", hubUrl: "http://h" }, { fetchImpl: fake(remote, hosts), out: (s) => out.push(s) });
  return { code, body: JSON.parse(out.join("\n")) };
}

test("remote session adds its host row", async () => {
  const { code, body } = await run(true, [host]);
  expect(code).toBe(0);
  expect(body.host).toEqual(host);
  expect(body.session.session_id).toBe(ID);
});

test("local session has no host key", async () => {
  const { body } = await run(false, [host]);
  expect("host" in body).toBe(false);
});

test("remote session without matching row has no host key", async () => {
  const { body } = await run(true, [{ ...host, host: "other" }]);
  expect("host" in body).toBe(false);
});
