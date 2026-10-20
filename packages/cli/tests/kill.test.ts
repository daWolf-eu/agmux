import { test, expect, spyOn } from "bun:test";
import { killCmd } from "../src/kill.ts";

const ID = "019f1898-8e0f-7000-ab55-07d09f673b59";

test("killCmd on a remote row prints the refusal, exits 2, never signals", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) =>
    String(url).includes("/sessions?")
      ? new Response(JSON.stringify({ sessions: [{ session_id: ID }] }))
      : new Response(JSON.stringify({ session: { session_id: ID, host: "sbx-1", pid: 4242, remote: true } }))
  ) as unknown as typeof fetch;
  const kill = spyOn(process, "kill").mockImplementation(() => true);
  const err = spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(await killCmd({ idOrPrefix: "019f", signal: "SIGTERM", hubUrl: "http://hub" })).toBe(2);
    expect(kill).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalledWith("kill: 019f1898 runs on sbx-1; remote kill is not supported yet");
  } finally {
    globalThis.fetch = origFetch; kill.mockRestore(); err.mockRestore();
  }
});
