import { test, expect } from "bun:test";
import { $ } from "bun";
import { makeTestEnv, waitFor } from "./helpers.ts";

test("run → ls shows session → kill ends it", async () => {
  const env = makeTestEnv();
  const baseEnv = {
    HOME: env.stateDir.replace(/\.agmux$/, ""),
    XDG_CONFIG_HOME: env.stateDir.replace(/\.agmux$/, "") + "/.config",
    AGMUX_HUB_BIN: env.hubBin,
    AGMUX_WRAP_BIN: env.wrapBin,
    PATH: process.env.PATH ?? "",
  };

  // Launch in a detached tmux session named 'agmux-e2e' so we don't take over the user's terminal.
  await $`tmux new-session -d -s agmux-e2e '${env.cliBin} run echo'`.env(baseEnv);

  // Wait for the projection to surface a live session.
  let runningId = "";
  await waitFor(async () => {
    const out = await $`${env.cliBin} ls`.env(baseEnv).text();
    const lines = out.split("\n").slice(1).filter((l) => l.trim());
    if (lines.length >= 1) {
      runningId = lines[0]!.split(/\s+/)[0]!;
      return true;
    }
    return false;
  });

  expect(runningId).toMatch(/^[0-9a-f]{8}$/);

  await $`${env.cliBin} kill ${runningId}`.env(baseEnv);

  await waitFor(async () => {
    const out = await $`${env.cliBin} ls --all`.env(baseEnv).text();
    return out.includes(" ended ");
  });

  // Cleanup
  try { await $`tmux kill-session -t agmux-e2e`; } catch {}
  try { await $`tmux kill-session -t agmux`; } catch {}
});
