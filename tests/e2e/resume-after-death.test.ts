import { test, expect, afterEach } from "bun:test";
import { $ } from "bun";
import { makeTestEnv, waitFor, warmHub, cleanupAllTestEnvs } from "./helpers.ts";

// Override the wrapper's internal tmux session name so we never touch the user's real "agmux".
const innerSession = "agmux-e2e-internal";

// Teardown runs here, not at the end of the test body: an assertion that
// fails mid-test skips the rest of the body, which is how e2e runs used to
// strand a hub per test in a temp dir nobody deleted.
afterEach(async () => {
  try { await $`tmux kill-session -t agmux-e2e`.quiet(); } catch {}
  try { await $`tmux kill-session -t agmux-e2e-2`.quiet(); } catch {}
  try { await $`tmux kill-session -t agmux-e2e-internal`.quiet(); } catch {}
  cleanupAllTestEnvs();
});

test("after SIGKILL, attach <id> relaunches under same session_id (status=ended → idle)", async () => {
  const env = makeTestEnv();
  const baseEnv = {
    HOME: env.root,
    XDG_CONFIG_HOME: `${env.root}/.config`,
    AGMUX_HUB_BIN: env.hubBin,
    AGMUX_WRAP_BIN: env.wrapBin,
    AGMUX_TMUX_SESSION: innerSession,
    PATH: process.env.PATH ?? "",
  };

  // Bring up one hub first so the wrapper and the polling `ls` below don't race to spawn.
  await warmHub(env.cliBin, baseEnv);

  // `-p echo` selects the profile from config.toml (run is ad-hoc by default).
  await $`tmux new-session -d -s agmux-e2e '${env.cliBin} run -p echo'`.env(baseEnv);

  // Capture the session_id prefix from ls's first column, width-agnostically:
  // skip the header row, take the first whitespace-delimited token.
  let sid = "";
  await waitFor(async () => {
    const out = await $`${env.cliBin} ls`.env(baseEnv).text();
    const lines = out.split("\n").slice(1).filter((l) => l.trim());
    if (lines.length >= 1) {
      sid = lines[0]!.split(/\s+/)[0]!;
      return true;
    }
    return false;
  }, 15000);

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
  }, 15000);

  const final = JSON.parse(await $`${env.cliBin} inspect ${sid}`.env(baseEnv).text());
  expect(final.session.session_id.startsWith(sid)).toBe(true);
  expect(final.events.some((e: any) => e.kind === "session.resumed")).toBe(true);

}, 30000);
