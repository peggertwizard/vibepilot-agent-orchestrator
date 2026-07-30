-- How hard an agent thinks.
--
-- The shipped CLI takes --effort low|medium|high|xhigh|max (plus an `ultracode` alias meaning
-- xhigh *plus* a standing instruction to orchestrate sub-agents). vibePilot passed none of it.
--
-- NULL means "use the default for this role" rather than a literal level, so existing rows need
-- no backfill and the per-role defaults can be retuned later without overwriting anyone's
-- explicit choice.

ALTER TABLE agents ADD COLUMN effort TEXT;
