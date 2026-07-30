-- 009 — epics.
--
-- "Build a whole vibePilot with such and such instructions" is one request and a dozen
-- pieces. As one ticket it means one agent, sequentially, for hours, with no visible
-- progress. As linked tickets it means several builders in parallel and a board that tells
-- you where things stand.
--
-- The split is a CONVERSATION, not a fan-out: "there should be a bit more interactivity,
-- talking to the Pilot planning it." So the proposal is persisted and discussed before any
-- ticket exists. This is the one place vibePilot deliberately asks rather than decides.

CREATE TABLE epics (
  id                   TEXT PRIMARY KEY,
  project_id           TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title                TEXT NOT NULL,
  -- Two or three words. Printed on every child card, so it has to be short.
  short_label          TEXT NOT NULL,
  -- Index into a fixed palette rather than a hex value: the spine has to work in both
  -- themes, and a colour the model picked would not.
  colour_index         INTEGER NOT NULL DEFAULT 0,
  summary              TEXT NOT NULL DEFAULT '',
  status               TEXT NOT NULL DEFAULT 'proposed'
                         CHECK (status IN ('proposed','active','done','rejected')),
  proposed_by_agent_id TEXT,
  -- The breakdown, while it is still being argued about. Emptied once tickets exist —
  -- after that the tickets ARE the epic and a second copy could only disagree with them.
  pieces_json          TEXT NOT NULL DEFAULT '[]',
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  resolved_at          INTEGER
);
CREATE INDEX idx_epics_project ON epics(project_id, status);

ALTER TABLE tickets ADD COLUMN epic_id TEXT;
CREATE INDEX idx_tickets_epic ON tickets(epic_id);
