import { test, expect, beforeAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { probeGit, repoFromRemote, repoFromCommonDir, execGit } from "../src/git-meta.ts";

test("repoFromRemote: ssh, https, trailing slash, local path", () => {
  expect(repoFromRemote("git@github.com:daWolf-eu/agmux.git")).toBe("agmux");
  expect(repoFromRemote("https://github.com/daWolf-eu/agmux")).toBe("agmux");
  expect(repoFromRemote("https://host/group/sub/agmux.git/")).toBe("agmux");
  expect(repoFromRemote("/srv/git/agmux.git")).toBe("agmux");
  expect(repoFromRemote("")).toBeNull();
});

test("repoFromCommonDir: .git dir vs bare/worktree hub", () => {
  expect(repoFromCommonDir("/src/AGX/.git")).toBe("AGX");
  expect(repoFromCommonDir("/src/AGX.git")).toBe("AGX");
});

test("probeGit: not a repo costs one call and returns null", async () => {
  const calls: string[][] = [];
  const r = await probeGit("/nowhere", async (_c, a) => { calls.push(a); return null; });
  expect(r).toBeNull();
  expect(calls).toHaveLength(1);
});

test("probeGit: detached HEAD → branch null; no remote → repo from common dir", async () => {
  const r = await probeGit("/src/AGX", async (_c, a) => {
    if (a[0] === "rev-parse") return "/src/AGX\n.git";
    return null; // symbolic-ref fails (detached), no origin
  });
  expect(r).toEqual({ branch: null, repo: "AGX", remote: null, root: "/src/AGX" });
});

// Real git, real worktree: the case this repo itself lives in.
let base = "";
const sh = (cwd: string, ...args: string[]) => {
  const p = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(p.stderr.toString());
};
beforeAll(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agmux-git-")));
  const main = path.join(base, "proj");
  fs.mkdirSync(main);
  sh(main, "init", "-q", "-b", "main");
  sh(main, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
  sh(main, "worktree", "add", "-q", "-b", "feature/x", path.join(base, "proj.feature-x"));
});

test("probeGit (real git): main checkout, subdirectory", async () => {
  const sub = path.join(base, "proj", "src");
  fs.mkdirSync(sub, { recursive: true });
  expect(await probeGit(sub, execGit)).toEqual({ branch: "main", repo: "proj", remote: null, root: path.join(base, "proj") });
});

test("probeGit (real git): a linked worktree names the main repo and its own branch", async () => {
  const wt = path.join(base, "proj.feature-x");
  sh(wt, "remote", "add", "origin", "git@github.com:o/agmux.git");
  expect(await probeGit(wt, execGit)).toEqual({
    branch: "feature/x", repo: "agmux", remote: "git@github.com:o/agmux.git", root: wt,
  });
});

test("probeGit (real git): outside any repo → null", async () => {
  expect(await probeGit(base, execGit)).toBeNull();
});
