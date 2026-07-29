-- Things that differ between a scratch repo and a live business site.
--
-- Every column here replaces a value that was hardcoded, global, or prose. The test commands are
-- the important ones: verification used to be a sentence in a rule file — "the project's tests
-- pass" — and nothing checked whether it had happened, so an agent that said it verified and one
-- that did were indistinguishable. Naming the commands makes the claim checkable.
--
-- All nullable, all optional. A project that sets none of them behaves exactly as before, which is
-- what makes this safe to apply to a database with work already in it.

ALTER TABLE projects ADD COLUMN cmd_test TEXT;
ALTER TABLE projects ADD COLUMN cmd_typecheck TEXT;
ALTER TABLE projects ADD COLUMN cmd_lint TEXT;
ALTER TABLE projects ADD COLUMN cmd_build TEXT;

-- Deploy is the one action that reaches the outside world. Stored so the Pilot can run it when
-- asked; never run on its own initiative.
ALTER TABLE projects ADD COLUMN deploy_cmd TEXT;
ALTER TABLE projects ADD COLUMN deploy_note TEXT;

-- Was MAX_REVIEW_PASSES, a module constant. Some repos want one pass and some want more.
ALTER TABLE projects ADD COLUMN review_passes INTEGER;

-- The Pilot's model was a single global localStorage key, so a throwaway repo and a business
-- project shared one expensive model. Effort sits beside it for the same reason.
ALTER TABLE projects ADD COLUMN pilot_model TEXT;
ALTER TABLE projects ADD COLUMN pilot_effort TEXT;

-- The project-level backstop under the per-ticket budgets. NULL means no ceiling.
ALTER TABLE projects ADD COLUMN spend_ceiling_usd REAL;
