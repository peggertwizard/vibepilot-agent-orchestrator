-- Per-ticket and per-epic spend budgets.
--
-- NULL means "use the default for this step kind" (STEP_BUDGET_USD), so nothing needs
-- backfilling and the defaults can change later without rewriting anyone's choices.
--
-- The ticket number is the one that is enforced: it becomes the agent's briefed target and,
-- doubled, its --max-budget-usd cap. The epic number is a ceiling across a piece of work split
-- into several tickets — it is tracked and shown, not separately enforced, because enforcing
-- both would mean two limits racing on the same run.

ALTER TABLE tickets ADD COLUMN budget_usd REAL;
ALTER TABLE epics   ADD COLUMN budget_usd REAL;
