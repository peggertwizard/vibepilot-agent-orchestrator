-- 005 — per-ticket routing replaces the fixed pipeline.
--
-- v1 walked every ticket through Plan → Build → Verify → Merge. That is over-process applied
-- uniformly: a typo fix needs no planning, and "which file handles session expiry?" needs no
-- building at all. The Pilot now proposes a route per ticket; the user accepts or edits it.

-- ── tickets: widen the stage vocabulary ──────────────────────────────────────────
-- `stage` was CHECKed against the old ('plan','build','verify'). SQLite cannot alter a
-- CHECK, so the table is rebuilt. Safe here because NOTHING declares a foreign key onto
-- tickets — the ticket_id columns elsewhere are deliberately plain TEXT. Anything added
-- later that does reference tickets must be created AFTER this rebuild.

CREATE TABLE tickets_new (
  id                 TEXT PRIMARY KEY,
  project_id         TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  number             INTEGER NOT NULL,
  title              TEXT NOT NULL,
  body               TEXT NOT NULL DEFAULT '',
  lane               TEXT NOT NULL DEFAULT 'backlog'
                       CHECK (lane IN ('backlog','todo','in_progress','done')),
  -- Mirror of the active route step, kept so the board and every existing query keep
  -- working. The route is the truth; this is derived and written only by the route repo.
  stage              TEXT CHECK (stage IN ('research','plan','build','review')),
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
  -- The Pilot's proposed ordering of the backlog. "I don't want every ticket I create to
  -- immediately get handled — there should be sensibility about what needs doing before
  -- what's already being worked on." NULL sorts last, so unranked tickets fall to the bottom.
  backlog_rank       INTEGER,
  cost_usd           REAL NOT NULL DEFAULT 0,
  archived_at        INTEGER,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  UNIQUE (project_id, number)
);

INSERT INTO tickets_new
  (id, project_id, number, title, body, lane, stage, needs_planning, ready_to_merge,
   merge_state, conflict_files_json, assignee_agent_id, branch, worktree_path, base_sha,
   head_sha, size_note, parked_reason, depends_on_json, backlog_rank, cost_usd, archived_at,
   created_at, updated_at)
SELECT
  id, project_id, number, title, body, lane,
  CASE stage WHEN 'verify' THEN 'review' ELSE stage END,
  needs_planning, ready_to_merge, merge_state, conflict_files_json, assignee_agent_id,
  branch, worktree_path, base_sha, head_sha, size_note, parked_reason, depends_on_json,
  NULL, cost_usd, archived_at, created_at, updated_at
FROM tickets;

DROP TABLE tickets;
ALTER TABLE tickets_new RENAME TO tickets;
CREATE INDEX idx_tickets_board ON tickets(project_id, lane, archived_at);

-- ── routes ───────────────────────────────────────────────────────────────────────
-- Steps live in one JSON column rather than their own table. They are an ordered list that
-- is always read and written whole; a child table would buy a join and an ordering column
-- and nothing else. JSON1 is available if a query ever genuinely needs to reach inside.
CREATE TABLE ticket_routes (
  id                   TEXT PRIMARY KEY,
  ticket_id            TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  project_id           TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- proposed: shown to the user as a card. accepted: the live route, at most one per ticket.
  -- superseded: kept, never deleted, so you can see what was proposed before.
  status               TEXT NOT NULL DEFAULT 'proposed'
                         CHECK (status IN ('proposed','accepted','rejected','superseded')),
  -- One line on why this route and not a shorter one. Shown on the card.
  rationale            TEXT NOT NULL DEFAULT '',
  proposed_by_agent_id TEXT,
  -- True when vibePilot applied it without asking — the trivial single-build case.
  auto_accepted        INTEGER NOT NULL DEFAULT 0,
  steps_json           TEXT NOT NULL DEFAULT '[]',
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  resolved_at          INTEGER
);
CREATE INDEX idx_routes_ticket ON ticket_routes(ticket_id, status);
CREATE INDEX idx_routes_open ON ticket_routes(project_id, status);

-- Backfill: every existing ticket gets an accepted route reflecting where it actually is,
-- so nothing on the board loses its stage the moment this ships.
INSERT INTO ticket_routes (id, ticket_id, project_id, status, rationale, auto_accepted,
                           steps_json, created_at, updated_at, resolved_at)
SELECT
  'bf_' || t.id,
  t.id,
  t.project_id,
  'accepted',
  'Carried over from the fixed pipeline.',
  1,
  CASE
    WHEN t.needs_planning = 1 THEN
      json_array(
        json_object('id','bf1','kind','plan','assigneeAgentId',t.assignee_agent_id,
                    'status', CASE WHEN t.stage = 'plan' THEN 'active' ELSE 'done' END,
                    'passes',1,'note',NULL),
        json_object('id','bf2','kind','build','assigneeAgentId',t.assignee_agent_id,
                    'status', CASE WHEN t.stage = 'build' THEN 'active'
                                   WHEN t.stage = 'plan' THEN 'pending' ELSE 'done' END,
                    'passes',1,'note',NULL))
    ELSE
      json_array(
        json_object('id','bf1','kind','build','assigneeAgentId',t.assignee_agent_id,
                    'status', CASE WHEN t.lane = 'done' THEN 'done' ELSE 'active' END,
                    'passes',1,'note',NULL))
  END,
  t.created_at,
  t.updated_at,
  t.updated_at
FROM tickets t;
