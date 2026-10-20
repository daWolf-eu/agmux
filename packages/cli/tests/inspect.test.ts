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

test("failing or malformed /hosts is optional", async () => {
  const out: string[] = [];
  const base = fake(true, []);
  for (const mode of ["throw", "nohosts"]) {
    const f = (async (url: string) => {
      if (String(url).includes("/hosts")) {
        if (mode === "throw") throw new Error("down");
        return new Response("{}");
      }
      return base(url);
    }) as unknown as typeof fetch;
    out.length = 0;
    expect(await inspectCmd({ idOrPrefix: "1111", hubUrl: "http://h" }, { fetchImpl: f, out: (s) => out.push(s) })).toBe(0);
    expect("host" in JSON.parse(out.join("\n"))).toBe(false);
  }
});

test("output is JSON-escaped for the terminal: no raw C0, DEL or C1 character", async () => {
  const evil = "x\x1b]52;c;ZXZpbA==\x07\x7f\x9b[2Jy";
  const fetchImpl = (async (url: string) => {
    const u = String(url);
    if (u.includes("/sessions?")) return new Response(JSON.stringify({ sessions: [{ session_id: ID }] }));
    return new Response(JSON.stringify({ session: { session_id: ID, host: "h", remote: false, name: evil }, events: [] }));
  }) as unknown as typeof fetch;
  const out: string[] = [];
  await inspectCmd({ idOrPrefix: "1111", hubUrl: "http://h" }, { fetchImpl, out: (s) => out.push(s) });
  const text = out.join("\n");
  expect(text).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
  expect(JSON.parse(text).session.name).toBe(evil);
});
