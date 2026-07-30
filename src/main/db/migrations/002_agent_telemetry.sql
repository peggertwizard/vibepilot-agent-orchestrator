-- 002 — per-agent telemetry.
--
-- Dollars were the wrong unit: a subscription is not billed per token, so the figure was
-- notional and unactionable. Tokens and context headroom are what actually constrain work.

-- What the CLI reported back for --model. We pass an alias ("sonnet"); this is what it
-- resolved to ("claude-sonnet-5"). Showing the resolution rather than our guess means the
-- UI can never claim a model that does not exist.
ALTER TABLE agents ADD COLUMN resolved_model TEXT;

ALTER TABLE agents ADD COLUMN tokens_in INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agents ADD COLUMN tokens_out INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agents ADD COLUMN tokens_cache_read INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agents ADD COLUMN tokens_cache_write INTEGER NOT NULL DEFAULT 0;

-- Context headroom, from result.usage + modelUsage[].contextWindow. Nullable because it is
-- unknown until the first turn completes.
ALTER TABLE agents ADD COLUMN context_used INTEGER;
ALTER TABLE agents ADD COLUMN context_max INTEGER;

-- Project-level quota state, from rate_limit_event. Anthropic exposes no plan-quota number,
-- so this is the only honest signal available: a status and a reset time.
ALTER TABLE projects ADD COLUMN rate_limit_status TEXT;
ALTER TABLE projects ADD COLUMN rate_limit_resets_at INTEGER;
