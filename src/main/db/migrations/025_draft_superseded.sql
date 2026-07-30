-- A revised draft is not a rejected one.
--
-- There were four ways a draft could end and none of them meant "the user asked for changes and
-- this is the new version". So a correction typed in chat produced a *second* card beside the
-- first, and pressing Discard on the old one told the Pilot the user had turned the idea down.
-- Do that twice while explaining what to fix and the Pilot concludes it is guessing wrong and
-- stops asking — which is exactly what happened, and it was the app's account of events rather
-- than the user's.
--
-- `superseded` is the missing fifth ending: the card goes away, the work is still wanted, and
-- nobody is told to drop the idea.
--
-- SQLite cannot alter a CHECK constraint, so the table is rebuilt. Columns are spelled out to
-- match 001_init exactly — the payload lives in `payload_json`, not in per-field columns.

PRAGMA foreign_keys = OFF;

CREATE TABLE ticket_drafts_new (
  id                    TEXT PRIMARY KEY,
  project_id            TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  proposed_by_agent_id  TEXT,
  payload_json          TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','created','parked','rejected','superseded')),
  ticket_id             TEXT,
  created_at            INTEGER NOT NULL,
  resolved_at           INTEGER
);

INSERT INTO ticket_drafts_new (id, project_id, proposed_by_agent_id, payload_json, status,
                               ticket_id, created_at, resolved_at)
  SELECT id, project_id, proposed_by_agent_id, payload_json, status,
         ticket_id, created_at, resolved_at
  FROM ticket_drafts;

DROP TABLE ticket_drafts;
ALTER TABLE ticket_drafts_new RENAME TO ticket_drafts;

CREATE INDEX idx_drafts_open ON ticket_drafts(project_id, status);

PRAGMA foreign_keys = ON;
