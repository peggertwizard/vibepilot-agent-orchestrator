-- 001_init — core schema.
-- Ids are TEXT (short base64url), timestamps INTEGER epoch-ms, booleans INTEGER 0|1.

CREATE TABLE projects (
  id                    TEXT PRIMARY KEY,
  name                  TEXT NOT NULL,
  path                  TEXT NOT NULL UNIQUE,
  git_remote            TEXT,
  default_base_branch   TEXT NOT NULL DEFAULT 'main',
  max_concurrent_agents INTEGER NOT NULL DEFAULT 3,
  -- Monotonic per-project ticket counter. MAX(number)+1 races when the Pilot and a
  -- teammate both create a ticket in the same tick; this is bumped inside the same
  -- transaction as the insert.
  ticket_seq            INTEGER NOT NULL DEFAULT 0,
  archived_at           INTEGER,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);

CREATE TABLE agents (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_agent_id  TEXT REFERENCES agents(id) ON DELETE SET NULL,
  name             TEXT NOT NULL,
  role             TEXT NOT NULL,
  avatar_initials  TEXT NOT NULL,
  provider         TEXT NOT NULL CHECK (provider IN ('claude','codex')),
  model            TEXT NOT NULL,
  is_pilot         INTEGER NOT NULL DEFAULT 0,
  ephemeral        INTEGER NOT NULL DEFAULT 1,
  status           TEXT NOT NULL DEFAULT 'idle' CHECK (status IN
                     ('idle','queued','starting','thinking','working','waiting_on_you',
                      'paused','blocked','stalled','error','done')),
  status_line      TEXT,
  current_ticket_id TEXT,
  -- Pre-minted before spawn, so a crash before the first system/init still leaves a
  -- --resume handle. NOTE: sessions are cwd-bound (see docs/architecture/00-spikes.md),
  -- so this is only usable while worktree_path still exists.
  session_id       TEXT,
  worktree_path    TEXT,
  stopped_reason   TEXT,
  started_at       INTEGER,
  last_event_at    INTEGER,
  active_ms        INTEGER NOT NULL DEFAULT 0,
  cost_usd         REAL NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX idx_agents_project_status ON agents(project_id, status);

-- One row per OS process. An agent outlives many runs (pause/resume/restart), and the
-- boot reaper needs per-process pid + argv + exit code to identify its own orphans.
CREATE TABLE agent_runs (
  id              TEXT PRIMARY KEY,
  agent_id        TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  ticket_id       TEXT,
  provider        TEXT NOT NULL,
  session_id      TEXT,
  resumed_from    TEXT,
  pid             INTEGER,
  -- Guards against pid reuse: a recycled pid will not match this start time.
  pid_started_at  INTEGER,
  cwd             TEXT,
  argv_json       TEXT,            -- redacted: bearer token stripped before storing
  exit_code       INTEGER,
  exit_signal     TEXT,
  terminal_reason TEXT,
  checkpoint_json TEXT,
  started_at      INTEGER NOT NULL,
  ended_at        INTEGER
);
CREATE INDEX idx_runs_open ON agent_runs(project_id) WHERE ended_at IS NULL;
CREATE INDEX idx_runs_agent ON agent_runs(agent_id, started_at);

CREATE TABLE tickets (
  id                 TEXT PRIMARY KEY,
  project_id         TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  number             INTEGER NOT NULL,
  title              TEXT NOT NULL,
  body               TEXT NOT NULL DEFAULT '',
  lane               TEXT NOT NULL DEFAULT 'backlog'
                       CHECK (lane IN ('backlog','todo','in_progress','done')),
  stage              TEXT CHECK (stage IN ('plan','build','verify')),
  needs_planning     INTEGER NOT NULL DEFAULT 0,
  ready_to_merge     INTEGER NOT NULL DEFAULT 0,
  merge_state        TEXT NOT NULL DEFAULT 'none'
                       CHECK (merge_state IN ('none','cpd_running','conflict','ready','merged','failed')),
  conflict_files_json TEXT NOT NULL DEFAULT '[]',
  assignee_agent_id  TEXT,
  branch             TEXT,
  worktree_path      TEXT,
  base_sha           TEXT,
  head_sha           TEXT,
  size_note          TEXT,
  parked_reason      TEXT,
  depends_on_json    TEXT NOT NULL DEFAULT '[]',
  cost_usd           REAL NOT NULL DEFAULT 0,
  archived_at        INTEGER,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  UNIQUE (project_id, number)
);
CREATE INDEX idx_tickets_board ON tickets(project_id, lane, archived_at);

-- A proposed ticket is a real persisted object: the draft card must survive an app
-- restart while the user decides. propose_ticket never creates a ticket directly.
CREATE TABLE ticket_drafts (
  id                    TEXT PRIMARY KEY,
  project_id            TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  proposed_by_agent_id  TEXT,
  payload_json          TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','created','parked','rejected')),
  ticket_id             TEXT,
  created_at            INTEGER NOT NULL,
  resolved_at           INTEGER
);
CREATE INDEX idx_drafts_open ON ticket_drafts(project_id, status);

CREATE TABLE messages (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  agent_id         TEXT,
  run_id           TEXT,
  author_type      TEXT NOT NULL CHECK (author_type IN ('user','agent','system')),
  kind             TEXT NOT NULL DEFAULT 'text'
                     CHECK (kind IN ('text','notice','draft','tool_summary','interrupted','error')),
  body             TEXT NOT NULL DEFAULT '',
  provider_msg_id  TEXT,          -- Anthropic msg_… — dedup guard on resume
  tool_summary_json TEXT NOT NULL DEFAULT '[]',
  attachments_json TEXT NOT NULL DEFAULT '[]',
  created_at       INTEGER NOT NULL
);
CREATE INDEX idx_messages_project_time ON messages(project_id, created_at);

-- Lifecycle + tool events only. agent:text / agent:thinking deltas are transient and
-- deliberately never persisted here — the assembled `assistant` message is authoritative.
CREATE TABLE agent_events (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id   TEXT NOT NULL,
  agent_id     TEXT NOT NULL,
  run_id       TEXT,
  ticket_id    TEXT,
  type         TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_events_agent ON agent_events(agent_id, seq);
CREATE INDEX idx_events_project ON agent_events(project_id, seq);

CREATE TABLE comms (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('dm','shoutout')),
  from_agent_id TEXT,
  to_agent_id   TEXT,             -- NULL for a shoutout
  severity      TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info','warn','blocker')),
  body          TEXT NOT NULL,
  ticket_id     TEXT,
  read_at       INTEGER,
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_comms_project_time ON comms(project_id, created_at);

CREATE TABLE questions (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  agent_id     TEXT NOT NULL,
  ticket_id    TEXT,
  question     TEXT NOT NULL,
  context      TEXT,
  choices_json TEXT NOT NULL DEFAULT '[]',
  urgency      TEXT NOT NULL DEFAULT 'blocking' CHECK (urgency IN ('blocking','background')),
  status       TEXT NOT NULL DEFAULT 'open'
                 CHECK (status IN ('open','answered','orphaned','cancelled')),
  answer       TEXT,
  asked_at     INTEGER NOT NULL,
  answered_at  INTEGER
);
CREATE INDEX idx_questions_open ON questions(project_id) WHERE status = 'open';

CREATE TABLE memory_entries (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  scope           TEXT NOT NULL DEFAULT 'project',
  ticket_id       TEXT,
  category        TEXT NOT NULL,
  title           TEXT NOT NULL,
  body            TEXT NOT NULL,
  source_agent_id TEXT,
  hit_count       INTEGER NOT NULL DEFAULT 0,
  last_used_at    INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX idx_memory_project ON memory_entries(project_id, category);

CREATE VIRTUAL TABLE memory_fts USING fts5(
  title, body, content='memory_entries', content_rowid='rowid'
);
CREATE TRIGGER memory_ai AFTER INSERT ON memory_entries BEGIN
  INSERT INTO memory_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;
CREATE TRIGGER memory_ad AFTER DELETE ON memory_entries BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
END;
CREATE TRIGGER memory_au AFTER UPDATE ON memory_entries BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
  INSERT INTO memory_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;

CREATE TABLE usage_events (
  id                    TEXT PRIMARY KEY,
  project_id            TEXT NOT NULL,
  agent_id              TEXT NOT NULL,
  run_id                TEXT,
  ticket_id             TEXT,
  provider              TEXT NOT NULL,
  model                 TEXT NOT NULL,
  input_tokens          INTEGER NOT NULL DEFAULT 0,
  output_tokens         INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd              REAL NOT NULL DEFAULT 0,
  cost_source           TEXT NOT NULL DEFAULT 'provider'
                          CHECK (cost_source IN ('provider','estimated')),
  created_at            INTEGER NOT NULL
);
CREATE INDEX idx_usage_project_time ON usage_events(project_id, created_at);

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
