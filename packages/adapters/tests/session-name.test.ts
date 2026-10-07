import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { claudeAdapter } from "../src/adapters/claude/index.ts";
import { codexAdapter } from "../src/adapters/codex/index.ts";
import { piAdapter } from "../src/adapters/pi/index.ts";
import { EXTENSION_FILES } from "../src/adapters/pi/extension-files.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "agmux-name-"));
const jsonl = (recs: object[]) => recs.map((r) => JSON.stringify(r)).join("\n") + "\n";

function transcript(recs: object[]): string {
  const p = path.join(tmp(), "t.jsonl");
  fs.writeFileSync(p, jsonl(recs));
  return p;
}

test("claude: the latest ai-title is the agent's name", () => {
  const p = transcript([
    { type: "user", message: { content: "hi" } },
    { type: "ai-title", aiTitle: "First guess", sessionId: "s" },
    { type: "assistant", message: { content: "x" } },
    { type: "ai-title", aiTitle: "Fix flaky e2e tests", sessionId: "s" },
  ]);
  expect(claudeAdapter.sessionName!({ transcript_path: p }, {})).toEqual({ name: "Fix flaky e2e tests", source: "agent" });
});

test("claude: a /rename (custom-title) beats the generated title, even when older", () => {
  const p = transcript([
    { type: "custom-title", customTitle: "e2e flake hunt", sessionId: "s" },
    { type: "ai-title", aiTitle: "Fix flaky e2e tests", sessionId: "s" },
  ]);
  expect(claudeAdapter.sessionName!({ transcript_path: p }, {})).toEqual({ name: "e2e flake hunt", source: "user" });
});

test("claude: no title records, no transcript, or a mention in message text → null", () => {
  // A message that merely quotes the record type must not count.
  const p = transcript([{ type: "user", message: { content: 'say "ai-title" please' } }]);
  expect(claudeAdapter.sessionName!({ transcript_path: p }, {})).toBeNull();
  expect(claudeAdapter.sessionName!({ transcript_path: "/nope.jsonl" }, {})).toBeNull();
  expect(claudeAdapter.sessionName!({}, {})).toBeNull();
});

test("codex: thread_name from $CODEX_HOME/session_index.jsonl, last entry wins", () => {
  const home = tmp();
  fs.writeFileSync(path.join(home, "session_index.jsonl"), jsonl([
    { id: "t-1", thread_name: "old name", updated_at: "x" },
    { id: "t-2", thread_name: "other thread", updated_at: "x" },
    { id: "t-1", thread_name: "Refactor auth", updated_at: "y" },
  ]));
  expect(codexAdapter.sessionName!({ session_id: "t-1" }, { CODEX_HOME: home })).toEqual({ name: "Refactor auth", source: "agent" });
  expect(codexAdapter.sessionName!({ session_id: "t-9" }, { CODEX_HOME: home })).toBeNull();
  expect(codexAdapter.sessionName!({ session_id: "t-1" }, { CODEX_HOME: path.join(home, "missing") })).toBeNull();
});

test("pi: the extension's session_name is the user's /name", () => {
  expect(piAdapter.sessionName!({ session_id: "p", session_name: " docs pass " }, {})).toEqual({ name: "docs pass", source: "user" });
  expect(piAdapter.sessionName!({ session_id: "p", session_name: null }, {})).toBeNull();
});

test("pi extension reports session_name and cwd at registration and turn end", () => {
  const src = EXTENSION_FILES[0]!.content;
  expect(src).toContain("getSessionName");
  expect(src).toMatch(/point=session\.registered"\], \{[^}]*session_name: sessionName\(ctx\)/);
  expect(src).toMatch(/emitPoint\("turn\.ended", ctx, \{ cwd: [^}]*session_name: sessionName\(ctx\)/);
});
