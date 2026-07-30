-- Three dials that mean something, and one that never did.
--
-- `review_sensitivity` decides when a route earns a reviewer. It replaces a sentence in the
-- Pilot's prompt reading "something visual, risky, or hard to undo earns a reviewer" — under
-- which a pricing card is visual, so a one-word copy change was given a second agent, a second
-- cold start and a second bill. The instruction was followed correctly; the instruction was
-- wrong. 1 is never, 10 is always, and every step is a superset of the one below it.
--
-- `launch_paused` holds the queue shut. Being at the concurrency cap is not the only reason to
-- want work to wait — sometimes you would simply rather run it later.
--
-- `max_concurrent_agents` already existed and was read by nothing anywhere in the main process.
-- It is enforced from this migration onwards, so the stored value finally means something.
ALTER TABLE projects ADD COLUMN review_sensitivity INTEGER NOT NULL DEFAULT 5;
ALTER TABLE projects ADD COLUMN launch_paused INTEGER NOT NULL DEFAULT 0;

-- `pilot_effort` is deliberately left in place rather than dropped. It is dead — written by the
-- settings screen and read by no spawn path — but the composer's picker writes the agent row,
-- which is the one that works. Dropping a column costs a table rebuild in SQLite; leaving an
-- unread column costs nothing. The UI that wrote it is what goes.
