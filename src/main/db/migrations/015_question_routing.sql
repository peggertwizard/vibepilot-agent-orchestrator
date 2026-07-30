-- Who answered, and how readily a project escalates.
--
-- `answered_by` exists because the teammate was being lied to. Every answer came back as
-- "The user answered: ..." regardless of where it came from, so once the Pilot can answer on
-- your behalf the teammate has no way to know whether a human ever saw the question. That
-- changes how much weight the answer deserves.
--
-- `pilot_asked_at` is a timestamp, not a status. Handing a question to the Pilot must not close
-- it: the row stays `open`, the card stays live, and you can still answer it yourself at any
-- moment. Whoever gets there first wins — the answer UPDATE is already `WHERE status = 'open'`.
--
-- `escalation` on the project is the dial. It lives here rather than in a settings blob because
-- exactly one thing reads it and a column is honest about that. The settings UI that exposes it
-- is plan 19; this is the storage and the default.

ALTER TABLE questions ADD COLUMN answered_by TEXT;
ALTER TABLE questions ADD COLUMN pilot_asked_at INTEGER;

ALTER TABLE projects ADD COLUMN escalation TEXT NOT NULL DEFAULT 'balanced';
