import { test, expect } from "bun:test";
import { $ } from "bun";
import { makeTestEnv, waitFor } from "./helpers.ts";

test("after SIGKILL, attach <id> relaunches under same session_id (status=ended → idle)", async () => {
  const env = makeTestEnv();
  // Override the wrapper's internal tmux session name so we never touch the user's real "agmux".
  const innerSession = "agmux-e2e-internal";
  const baseEnv = {
    HOME: env.stateDir.replace(/\.agmux$/, ""),
    XDG_CONFIG_HOME: env.stateDir.replace(/\.agmux$/, "") + "/.config",
    AGMUX_HUB_BIN: env.hubBin,
    AGMUX_WRAP_BIN: env.wrapBin,
    AGMUX_TMUX_SESSION: innerSession,
    PATH: process.env.PATH ?? "",
  };

  await $`tmux new-session -d -s agmux-e2e '${env.cliBin} run echo'`.env(baseEnv);

  let sid = "";
  await waitFor(async () => {
    const out = await $`${env.cliBin} ls`.env(baseEnv).text();
    const m = out.match(/^([0-9a-f]{8})\s/m);
    if (m) { sid = m[1]!; return true; }
    return false;
  });

  // SIGKILL: kill the wrapper pid (no graceful end event)
  const insp = JSON.parse(await $`${env.cliBin} inspect ${sid}`.env(baseEnv).text());
  process.kill(insp.session.pid, "SIGKILL");

  // Status becomes 'lost' after >60s, or 'ended' if the kernel managed to propagate signal cleanup.
  // For the e2e we only need to confirm `attach` produces a new live row under the same id.
  await new Promise((r) => setTimeout(r, 2000));
  await $`tmux new-session -d -s agmux-e2e-2 '${env.cliBin} attach ${sid}'`.env(baseEnv);

  await waitFor(async () => {
    const insp2 = JSON.parse(await $`${env.cliBin} inspect ${sid}`.env(baseEnv).text());
    const kinds = insp2.events.map((e: any) => e.kind);
    return kinds.includes("session.resumed");
  });

  const final = JSON.parse(await $`${env.cliBin} inspect ${sid}`.env(baseEnv).text());
  expect(final.session.session_id.startsWith(sid)).toBe(true);
  expect(final.events.some((e: any) => e.kind === "session.resumed")).toBe(true);

  // Cleanup — only kill sessions this test created; never touch the user's "agmux".
  try { await $`tmux kill-session -t agmux-e2e`; } catch {}
  try { await $`tmux kill-session -t agmux-e2e-2`; } catch {}
  try { await $`tmux kill-session -t ${innerSession}`; } catch {}
});
