-- A split proposal the conversation has moved past.
--
-- Proposals used to sit on the board until explicitly accepted or dropped, so talking the Pilot
-- round to a different breakdown left two on screen — either acceptable, both creating tickets.
-- A duplicate-ticket machine, sitting exactly where the board is meant to be telling you what
-- is happening.
--
-- `superseded` rather than `rejected`, because they are different facts: rejected is a decision
-- you made, superseded is one the conversation made for you. Collapsing them would lose the
-- only thing that distinguishes "I did not want that" from "we talked about it and moved on".
--
-- SQLite cannot alter a CHECK constraint in place, so this is the standard rebuild.
PRAGMA foreign_keys = OFF;

CREATE TABLE epics_new (
  id                   TEXT PRIMARY KEY,
  project_id           TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title                TEXT NOT NULL,
  short_label          TEXT NOT NULL,
  colour_index         INTEGER NOT NULL DEFAULT 0,
  summary              TEXT NOT NULL DEFAULT '',
  status               TEXT NOT NULL DEFAULT 'proposed'
                         CHECK (status IN ('proposed','active','done','rejected','superseded')),
  proposed_by_agent_id TEXT,
  pieces_json          TEXT NOT NULL DEFAULT '[]',
  resolved_at          INTEGER,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);

INSERT INTO epics_new
SELECT id, project_id, title, short_label, colour_index, summary, status,
       proposed_by_agent_id, pieces_json, resolved_at, created_at, updated_at
FROM epics;

DROP TABLE epics;
ALTER TABLE epics_new RENAME TO epics;

CREATE INDEX idx_epics_project ON epics(project_id, status);

PRAGMA foreign_keys = ON;
