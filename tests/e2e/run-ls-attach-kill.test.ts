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
  try { await $`tmux kill-session -t agmux-e2e-internal`.quiet(); } catch {}
  cleanupAllTestEnvs();
});

test("run → ls shows session → kill ends it", async () => {
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

  // Launch in a detached tmux session named 'agmux-e2e' so we don't take over the user's terminal.
  // `-p echo` selects the profile from config.toml (run is ad-hoc by default).
  await $`tmux new-session -d -s agmux-e2e '${env.cliBin} run -p echo'`.env(baseEnv);

  // Wait for the projection to surface a live session. Cold start spins up the hub,
  // wrapper, tmux and a PTY, so give it real headroom (well under the 30s test budget).
  let runningId = "";
  await waitFor(async () => {
    const out = await $`${env.cliBin} ls`.env(baseEnv).text();
    const lines = out.split("\n").slice(1).filter((l) => l.trim());
    if (lines.length >= 1) {
      runningId = lines[0]!.split(/\s+/)[0]!;
      return true;
    }
    return false;
  }, 15000);

  // Width-agnostic: just a session_id prefix token (hex + hyphens). The real
  // correctness check is that kill/inspect resolve it below — don't pin a width.
  expect(runningId).toMatch(/^[0-9a-f][0-9a-f-]+$/);

  await $`${env.cliBin} kill ${runningId}`.env(baseEnv);

  await waitFor(async () => {
    const out = await $`${env.cliBin} ls --all`.env(baseEnv).text();
    return out.includes(" ended ");
  }, 15000);

}, 30000);
