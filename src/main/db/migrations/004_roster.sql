-- 004 — a real team roster.
--
-- v1 had no way to create a teammate: only the Pilot could, via spawn_agent, and the Team
-- screen was read-only. Teammates are now first-class things you make and keep.

-- Free-form instructions, e.g. "you write the copy — never use the word 'seamless'".
-- Prepended to every turn that teammate takes, after the project rules.
ALTER TABLE agents ADD COLUMN instructions TEXT NOT NULL DEFAULT '';

-- Roster members persist across tickets and accumulate memory. Ephemeral agents are the
-- old behaviour: spawned for one ticket, discarded after.
ALTER TABLE agents ADD COLUMN is_roster INTEGER NOT NULL DEFAULT 0;

-- Nothing on the roster is ephemeral, and vice versa.
UPDATE agents SET is_roster = 1 WHERE is_pilot = 1;

-- Remap the v1 role taxonomy (scout/planner/implementer/reviewer/tester) onto the new one.
-- Narrow per-stage roles forced a handoff per stage; each handoff costs a cold start and
-- loses everything the previous agent learned. Builder owns a ticket end to end instead.
UPDATE agents SET role = 'builder'  WHERE role IN ('implementer', 'tester', 'planner');
UPDATE agents SET role = 'reviewer' WHERE role = 'reviewer';
UPDATE agents SET role = 'scout'    WHERE role = 'scout';
UPDATE agents SET role = 'builder'
WHERE is_pilot = 0 AND role NOT IN ('builder', 'reviewer', 'scout', 'specialist');
