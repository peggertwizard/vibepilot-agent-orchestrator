-- 011 — clear context figures recorded by the broken meter.
--
-- Before 010, `context_used` was the turn's token total summed across every API round-trip
-- (see the fix in providers/claude/translate.ts) and `context_max` was whichever model
-- happened to be first in `modelUsage`. Both are snapshots, written with
-- `COALESCE(?, context_used)` — so an agent that has not taken a turn since the fix still
-- displays its old, wrong pair, and one that never runs again would display it forever.
--
-- NULL rather than a guess: the meter renders nothing when it does not know, which is the
-- honest state. Every agent repopulates on its next turn.

UPDATE agents SET context_used = NULL, context_max = NULL;
