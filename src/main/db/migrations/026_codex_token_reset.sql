-- Clear token totals that are known to be wrong and cannot be recovered.
--
-- Codex reports `turn.completed.usage` cumulatively for the whole thread — measured on a
-- two-turn thread: input 19,051 then 39,686, output 5 then 10. vibePilot added each reading to
-- a running total, so every turn re-added everything before it and the figures grew
-- quadratically. One text ticket showed 5.28M tokens with a 2.61M "context", which is not a
-- large number, it is a wrong one.
--
-- 0.6.2 fixed the arithmetic going forward by emitting per-turn deltas. It cannot fix what is
-- already written: the individual readings were never stored, only the bad sum, so the true
-- total is not derivable from anything left in this database.
--
-- So the wrong numbers go, rather than being carried around for ever on a card. Zero is honest
-- here in a way the old figure never was — it says "not measured", and the next turn any of
-- these agents runs starts counting correctly.
--
-- Scoped to Codex agents alone. Claude's per-turn usage was always per-turn, its totals are
-- right, and nothing about them is touched.
UPDATE agents
   SET tokens_in          = 0,
       tokens_out         = 0,
       tokens_cache_read  = 0,
       tokens_cache_write = 0,
       context_used       = NULL
 WHERE provider = 'codex';
