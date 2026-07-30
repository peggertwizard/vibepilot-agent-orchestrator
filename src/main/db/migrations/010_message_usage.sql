-- 010 — what each individual answer cost.
--
-- `agents.tokens_*` (002) are cumulative: they answer "what has this agent spent in total",
-- which is the wrong question when you are looking at one reply and wondering why it was
-- expensive. `usage_events` is the per-turn ledger, but it keys on `run_id` — one OS
-- process, and the Pilot is deliberately long-lived across many turns — so it cannot name
-- the message it paid for either.
--
-- Nullable rather than DEFAULT 0. A turn killed mid-flight produces a message with no
-- figure, and "unknown" must not render as "0 tok" — that would be a confident lie about
-- something the user is reading to make a decision.

ALTER TABLE messages ADD COLUMN tokens_in INTEGER;
ALTER TABLE messages ADD COLUMN tokens_out INTEGER;
ALTER TABLE messages ADD COLUMN tokens_cache_read INTEGER;
ALTER TABLE messages ADD COLUMN tokens_cache_write INTEGER;
