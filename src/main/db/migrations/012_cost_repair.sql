-- Repair cost_usd, which has been accumulated wrongly since the beginning.
--
-- total_cost_usd from the CLI is the running total for the whole process, not
-- the cost of one turn. recordAgentUsage added it every turn, so each turn
-- re-added everything spent before it. A Pilot that cost $2.58 displayed $5.71.
--
-- The honest figure per run is the LAST (== maximum) reading for that run_id.
-- An agent's cost is the sum of those, one per run.
--
-- Agents with no usage_events rows keep whatever they had — there is nothing to
-- reconstruct from, and leaving them alone is better than zeroing them.

UPDATE agents
SET cost_usd = COALESCE(
      (
        SELECT SUM(r.run_max)
        FROM (
          SELECT agent_id, run_id, MAX(cost_usd) AS run_max
          FROM usage_events
          GROUP BY agent_id, run_id
        ) r
        WHERE r.agent_id = agents.id
      ),
      cost_usd
    );
