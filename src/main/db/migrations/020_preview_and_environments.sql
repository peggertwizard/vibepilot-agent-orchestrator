-- Seeing the change, then choosing where it goes.
--
-- The loop asked for is: change → it appears on localhost → I look at it → then I promote it.
-- None of the three steps existed. Finished work lived only in a worktree on `vp/<n>-<slug>`,
-- outside the user's own checkout, invisible until a merge. And `deploy_cmd`/`deploy_note`
-- have been stored on the project row since 016 and **executed by nothing** — they were pasted
-- into an agent's system prompt as prose. That was the entire deployment lifecycle.
--
-- `preview_cmd` is run IN THE WORKTREE, on its own port, when a ticket reaches ready. The
-- alternative — merging onto a preview branch inside the user's own checkout — was rejected
-- because it moves their HEAD, which is the one thing `squashMerge` was carefully taught not
-- to do. Isolation is the app's core promise and previewing is not worth trading it away.
--
-- `{port}` in the command is substituted. Anything else is passed through untouched.
ALTER TABLE projects ADD COLUMN preview_cmd TEXT;

-- Where finished work can go, and whether it asks first.
--
-- Deploying is not a new mechanism: it is `run_checks` with a different list and a gate.
-- `runCommand` already streams output, already has a timeout, and is already how checks work.
--
-- `confirm` is not a preference. Production is on the always-stops list at every autonomy
-- level, including "just run it" — a deploy is the one action here that reaches other people.
CREATE TABLE environments (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  cmd         TEXT NOT NULL,
  confirm     INTEGER NOT NULL DEFAULT 1,
  -- Ordering is the promotion ladder: dev before production, so a list reads as a sequence.
  position    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  UNIQUE (project_id, name)
);

-- What was deployed, where, and when. Without this "is the fix live?" is unanswerable, which
-- is the same gap that made the running version unanswerable before it was put in Settings.
CREATE TABLE deployments (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  environment_id TEXT REFERENCES environments(id) ON DELETE SET NULL,
  environment    TEXT NOT NULL,
  ticket_id      TEXT REFERENCES tickets(id) ON DELETE SET NULL,
  by_agent_id    TEXT REFERENCES agents(id) ON DELETE SET NULL,
  ok             INTEGER NOT NULL,
  exit_code      INTEGER,
  output         TEXT NOT NULL DEFAULT '',
  started_at     INTEGER NOT NULL,
  finished_at    INTEGER NOT NULL
);

CREATE INDEX idx_deployments_project ON deployments(project_id, started_at DESC);

-- Carry the old single command across as the first environment, rather than leaving it
-- stranded on the project row where it never did anything. Named "production" and set to
-- confirm, because a lone `deploy_cmd` that somebody bothered to fill in is overwhelmingly
-- likely to be the one that reaches other people.
INSERT INTO environments (id, project_id, name, cmd, confirm, position, created_at)
SELECT 'env-' || id, id, 'production', deploy_cmd, 1, 0, strftime('%s','now') * 1000
FROM projects
WHERE deploy_cmd IS NOT NULL AND trim(deploy_cmd) <> '';
