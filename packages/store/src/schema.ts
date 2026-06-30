export const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS _meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id      TEXT NOT NULL UNIQUE,
  ts            TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  kind          TEXT NOT NULL,
  version       INTEGER NOT NULL DEFAULT 1,
  payload       TEXT NOT NULL,
  host          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, id);
CREATE INDEX IF NOT EXISTS idx_events_kind_ts ON events(kind, ts);

CREATE TABLE IF NOT EXISTS sessions (
  session_id            TEXT PRIMARY KEY,
  agent_kind            TEXT NOT NULL,
  profile               TEXT,
  native_session_id     TEXT,
  command               TEXT NOT NULL,
  args_json             TEXT NOT NULL,
  env_json              TEXT NOT NULL,
  cwd                   TEXT NOT NULL,
  pid                   INTEGER,
  tmux_session          TEXT,
  tmux_window           TEXT,
  tmux_pane             TEXT,
  host                  TEXT NOT NULL,
  project               TEXT,
  parent_session_id     TEXT,
  start_ts              TEXT NOT NULL,
  last_heartbeat_ts     TEXT,
  end_ts                TEXT,
  exit_code             INTEGER,
  signal                TEXT,
  status                TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_status  ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project);
`;

export const SCHEMA_V2 = `
CREATE TABLE IF NOT EXISTS session_usage (
  session_id              TEXT PRIMARY KEY,
  input_tokens            INTEGER NOT NULL DEFAULT 0,
  output_tokens           INTEGER NOT NULL DEFAULT 0,
  reasoning_output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens       INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens      INTEGER NOT NULL DEFAULT 0,
  cost_usd                REAL NOT NULL DEFAULT 0,
  last_model              TEXT,
  last_rate_limit         TEXT,
  turn_count              INTEGER NOT NULL DEFAULT 0
);

ALTER TABLE events ADD COLUMN dedup_key TEXT;
-- Partial unique index: many NULLs allowed (the common case), but a non-null
-- dedup_key may appear at most once — source idempotency (§4.4).
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_dedup ON events(dedup_key) WHERE dedup_key IS NOT NULL;

ALTER TABLE sessions ADD COLUMN adapter_capabilities TEXT;
`;

export const SCHEMA_V3 = `
ALTER TABLE sessions ADD COLUMN origin TEXT NOT NULL DEFAULT 'wrapper';

-- The native-identity resolver (spec §2.3 / §5). Partial unique index: the many
-- wrapper rows with a NULL native id never collide, but a non-null
-- (agent_kind, native_session_id, host) triple may appear at most once — the
-- invariant that lets the hub resolve a native pointer to one canonical session.
CREATE UNIQUE INDEX IF NOT EXISTS idx_native_identity
  ON sessions(agent_kind, native_session_id, host)
  WHERE native_session_id IS NOT NULL;
`;

export const SCHEMA_V4 = `
-- Live-activity projection (what is the agent doing right now). The
-- working/waiting/idle state machine already lives in sessions.status; this
-- table only captures what events would otherwise drop: the current tool
-- (tool.used is log-only without it) and the awaited input kind. No FK,
-- matching session_usage. Null fields = nothing observed (yet).
CREATE TABLE IF NOT EXISTS session_activity (
  session_id       TEXT PRIMARY KEY,
  last_tool        TEXT,
  last_tool_detail TEXT,
  last_input_kind  TEXT,
  activity_ts      TEXT
);
`;

export const SCHEMA_V5 = `
ALTER TABLE sessions ADD COLUMN tmux_socket TEXT;
`;
