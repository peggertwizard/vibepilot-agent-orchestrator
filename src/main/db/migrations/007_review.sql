-- 007 — review findings.
--
-- v1 conflated two different jobs under "verify": does it RUN, and is it RIGHT. The first
-- is the builder's own job and is nearly free because it already has the context. The
-- second needs someone who did not write the code, because self-review catches "it crashes"
-- and misses "it looks broken".
--
-- A failed review does not create a ticket. It sends the same step back to the same builder
-- with a fix list, because that builder still has the whole problem in its head and a
-- replacement would pay a cold start to re-learn it.

CREATE TABLE ticket_findings (
  id            TEXT PRIMARY KEY,
  ticket_id     TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- Which review pass raised it. Findings from pass 1 stay visible in pass 2 so you can see
  -- whether the same thing keeps coming back.
  pass          INTEGER NOT NULL DEFAULT 1,
  by_agent_id   TEXT,
  severity      TEXT NOT NULL DEFAULT 'should'
                  CHECK (severity IN ('must', 'should', 'nit')),
  summary       TEXT NOT NULL,
  detail        TEXT NOT NULL DEFAULT '',
  file          TEXT,
  line          INTEGER,
  resolved_at   INTEGER,
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_findings_ticket ON ticket_findings(ticket_id, pass);
CREATE INDEX idx_findings_open ON ticket_findings(project_id) WHERE resolved_at IS NULL;
