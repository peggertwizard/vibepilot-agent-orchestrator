-- Finished work leaves the board on its own.
--
-- The Done column only ever grew. Every ticket the app had ever completed sat there, so the
-- one place that should read "here is what landed today" turned into a filing cabinet, and the
-- archive — which exists, and works — was something you had to remember to use, one ticket at
-- a time, from a menu.
--
-- Two columns, because "how long has this been done" is not a question the schema could answer.
-- `updated_at` moves for reasons that have nothing to do with finishing (a rename, a merge
-- state, a branch pointer), and `archived_at` is the answer, not the question. So `done_at` is
-- stamped when a ticket enters done or merged, and cleared if it comes back out — a ticket
-- dragged back to To do has not been done for three days, it is not done at all.
--
-- Three days, and on by default. The alternative — off, with a setting nobody finds — leaves
-- the pile exactly where it is for everyone who does not go looking, which is the problem.
-- Three days is long enough to see what landed over a weekend and short enough that the board
-- stays a board. Zero turns it off entirely.
--
-- Nothing is deleted. Archive has meant "still there, out of the way" since the first version
-- (`listTickets` filters it, the Archive toggle shows it, the detail panel still opens it), and
-- this changes only who presses the button.
ALTER TABLE tickets ADD COLUMN done_at INTEGER;
ALTER TABLE projects ADD COLUMN auto_archive_days INTEGER NOT NULL DEFAULT 3;

-- Stamp what is already finished as finished *now*, not whenever it happened.
--
-- The honest timestamp is not recoverable — that is why this column is being added. Backdating
-- with `updated_at` would be a guess that reads as fact, and on a board carrying months of
-- done tickets the guess would be "all of them are older than three days", so the first
-- heartbeat after the upgrade would sweep the entire Done column in one silent pass. Starting
-- everyone's clock at the upgrade gives three days of grace and a visible sweep instead.
UPDATE tickets
   SET done_at = CAST(strftime('%s','now') AS INTEGER) * 1000
 WHERE archived_at IS NULL
   AND done_at IS NULL
   AND (lane = 'done' OR merge_state = 'merged');
