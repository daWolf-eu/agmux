import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/migrations.ts";
import { applyEventToProjection } from "../src/project.ts";
import { getSessionRaw, explainSession } from "../src/queries.ts";
import { Store } from "../src/index.ts";

const T = (s: number) => `2026-10-07T10:00:${String(s).padStart(2, "0")}.000Z`;
const NOW = new Date("2026-10-07T10:01:00.000Z");
let n = 0;

function ev(db: Database, kind: string, ts: string, payload: any = {}, sid = "s1") {
  applyEventToProjection(db, { event_id: `e-${n++}`, ts, session_id: sid, kind, version: 1, host: "h", payload } as any);
}

function db0(): Database {
  const db = new Database(":memory:");
  runMigrations(db);
  ev(db, "session.registered", T(0), { native_session_id: "n1", agent_kind: "claude", pid: 1, cwd: "/src/agmux" });
  return db;
}

const git = { branch: "main", repo: "agmux", remote: "git@github.com:o/agmux.git", root: "/src/agmux" };
const row = (db: Database) => getSessionRaw(db, "s1", NOW)!;

test("session.metadata projects git facts and the name onto the row", () => {
  const db = db0();
  ev(db, "session.metadata", T(1), { git, name: { name: "Fix flaky tests", source: "agent" } });
  expect(row(db)).toMatchObject({
    name: "Fix flaky tests", name_source: "agent",
    git_branch: "main", git_repo: "agmux", git_remote: git.remote, git_root: "/src/agmux",
  });
});

test("groups update independently: a git-only event keeps the name", () => {
  const db = db0();
  ev(db, "session.metadata", T(1), { git, name: { name: "Fix flaky tests", source: "agent" } });
  ev(db, "session.metadata", T(2), { git: { ...git, branch: "fix/e2e" } });
  expect(row(db)).toMatchObject({ name: "Fix flaky tests", git_branch: "fix/e2e" });
});

test("a user rename replaces the agent title", () => {
  const db = db0();
  ev(db, "session.metadata", T(1), { name: { name: "Fix flaky tests", source: "agent" } });
  ev(db, "session.metadata", T(2), { name: { name: "e2e", source: "user" } });
  expect(row(db)).toMatchObject({ name: "e2e", name_source: "user" });
});

test("git: null (left the repo) clears the git fields", () => {
  const db = db0();
  ev(db, "session.metadata", T(1), { git });
  ev(db, "session.metadata", T(2), { git: null });
  expect(row(db)).toMatchObject({ git_branch: null, git_repo: null, git_root: null });
});

test("an older event cannot overwrite a newer observation", () => {
  const db = db0();
  ev(db, "session.metadata", T(5), { git: { ...git, branch: "new" }, name: { name: "new", source: "agent" } });
  ev(db, "session.metadata", T(3), { git: { ...git, branch: "old" }, name: { name: "old", source: "agent" } });
  expect(row(db)).toMatchObject({ git_branch: "new", name: "new" });
});

test("without a reported name, the parsed terminal title is the fallback", () => {
  const db = db0();
  ev(db, "title.changed", T(1), { title: "refactor auth", activity: "idle" });
  expect(row(db)).toMatchObject({ name: "refactor auth", name_source: "terminal" });
  ev(db, "session.metadata", T(2), { name: { name: "Auth refactor", source: "agent" } });
  expect(row(db)).toMatchObject({ name: "Auth refactor", name_source: "agent" });
});

test("an unparsed terminal title (shell, cwd) is not a name", () => {
  const db = db0();
  ev(db, "title.changed", T(1), { title: "zsh", activity: null });
  expect(row(db)).toMatchObject({ name: null, name_source: null });
});

test("metadata for an unknown session is inert", () => {
  const db = db0();
  ev(db, "session.metadata", T(1), { git }, "ghost");
  expect(db.query(`SELECT COUNT(*) AS c FROM session_meta`).get()).toEqual({ c: 0 });
});

test("explain carries the metadata", () => {
  const db = db0();
  ev(db, "session.metadata", T(1), { git, name: { name: "Fix flaky tests", source: "user" } });
  expect(explainSession(db, "s1", NOW)!.meta).toEqual({
    name: "Fix flaky tests", name_source: "user", git_repo: "agmux", git_branch: "main", git_root: "/src/agmux",
  });
});

test("rebuildProjections restores session_meta from the log", () => {
  const store = Store.openInMemory();
  const base = { version: 1, host: "h", session_id: "s1" };
  store.append({ ...base, event_id: "r", ts: T(0), kind: "session.registered", payload: { native_session_id: "n1", agent_kind: "claude", pid: 1, cwd: "/x" } } as any);
  store.append({ ...base, event_id: "m", ts: T(1), kind: "session.metadata", payload: { git } } as any);
  store.rebuildProjections();
  expect(store.getSession("s1")).toMatchObject({ git_branch: "main", git_repo: "agmux" });
});
