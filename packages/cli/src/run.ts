import { AGMUX_HUB_URL_ENV } from "@agmux/protocol";

export interface RunOpts { profileName: string; hubUrl: string; wrapBin: string; }

export async function runCmd(opts: RunOpts): Promise<number> {
  const child = Bun.spawn([opts.wrapBin, opts.profileName], {
    stdio: ["inherit", "inherit", "inherit"],
    env: { ...process.env, [AGMUX_HUB_URL_ENV]: opts.hubUrl },
  });
  await child.exited;
  return child.exitCode ?? 0;
}
