-- 008 — hiring becomes the user's decision.
--
-- v1 let the Pilot conjure teammates with spawn_agent, ad hoc, one per ticket, gone
-- afterwards. That is why the team felt like "empty shells": nobody persisted, nobody
-- accumulated memory, and the user had no say in who existed.
--
-- Now the Pilot *proposes* and the user approves. A proposal is a real persisted object for
-- the same reason a ticket draft is: the card must survive a restart while they decide.

CREATE TABLE hire_proposals (
  id                   TEXT PRIMARY KEY,
  project_id           TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  proposed_by_agent_id TEXT,
  name                 TEXT NOT NULL,
  role                 TEXT NOT NULL,
  provider             TEXT NOT NULL DEFAULT 'claude',
  model                TEXT NOT NULL,
  instructions         TEXT NOT NULL DEFAULT '',
  -- Shown on the card. A hire the user cannot see the reason for is a hire they will refuse.
  why                  TEXT NOT NULL DEFAULT '',
  -- Set when the proposal came out of the startup scan rather than a specific ticket.
  from_bootstrap       INTEGER NOT NULL DEFAULT 0,
  ticket_id            TEXT,
  status               TEXT NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending','hired','rejected')),
  agent_id             TEXT,
  created_at           INTEGER NOT NULL,
  resolved_at          INTEGER
);
CREATE INDEX idx_hires_open ON hire_proposals(project_id, status);

-- Remembers that a project has already been scanned, so we do not propose a starting team
-- again every time the app opens.
ALTER TABLE projects ADD COLUMN bootstrapped_at INTEGER;
