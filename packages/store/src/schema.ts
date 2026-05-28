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
