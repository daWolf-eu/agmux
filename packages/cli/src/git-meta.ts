import * as path from "node:path";
import type { GitMetadata } from "@agmux/protocol";

// Runs `git <args>` in `cwd`; stdout (trimmed) on exit 0, else null. Injectable
// so tests need no git binary.
export type GitExec = (cwd: string, args: string[]) => Promise<string | null>;

// Read-only and side-effect free (fleet's flags): no optional index locks, no
// fsmonitor daemon, no hooks, never a credential prompt. Runs on the agent's
// hot path (`agmux emit`), so it must not interfere with the agent's own git.
export const execGit: GitExec = async (cwd, args) => {
  try {
    const p = Bun.spawn(
      ["git", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-C", cwd, ...args],
      { stdout: "pipe", stderr: "ignore", stdin: "ignore", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" } },
    );
    const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
    return code === 0 ? out.trim() : null;
  } catch {
    return null; // no git binary, cwd gone, …
  }
};

// "git@github.com:org/agmux.git" | "https://host/org/agmux" | "/srv/agmux.git" → "agmux".
export function repoFromRemote(url: string): string | null {
  const last = url.trim().replace(/\/+$/, "").split(/[/:]/).pop() ?? "";
  const name = last.replace(/\.git$/, "");
  return name.length > 0 ? name : null;
}

// The main checkout's folder from the git common dir, which every worktree of a
// repo shares: "/x/AGX/.git" → "AGX", "/x/AGX.git" (bare / worktree hub) → "AGX".
export function repoFromCommonDir(commonDir: string): string | null {
  const base = path.basename(commonDir) === ".git" ? path.basename(path.dirname(commonDir)) : path.basename(commonDir);
  const name = base.replace(/\.git$/, "");
  return name.length > 0 ? name : null;
}

// Git facts for `cwd`, or null when it is not inside a work tree. One spawn when
// it is not a repo; three (two concurrent) when it is. Never throws.
export async function probeGit(cwd: string, git: GitExec = execGit): Promise<GitMetadata | null> {
  const loc = await git(cwd, ["rev-parse", "--show-toplevel", "--git-common-dir"]);
  if (!loc) return null;
  const [root, common] = loc.split("\n");
  if (!root || !common) return null;
  // symbolic-ref (not rev-parse --abbrev-ref) so an unborn branch still names
  // itself; it fails on a detached HEAD → branch null.
  const [branch, remote] = await Promise.all([
    git(cwd, ["symbolic-ref", "--short", "-q", "HEAD"]),
    git(cwd, ["config", "--get", "remote.origin.url"]),
  ]);
  return {
    branch: branch || null,
    repo: (remote ? repoFromRemote(remote) : null) ?? repoFromCommonDir(path.resolve(cwd, common)),
    remote: remote || null,
    root,
  };
}
