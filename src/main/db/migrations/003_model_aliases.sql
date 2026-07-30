-- 003 — normalise stale pinned model ids to aliases.
--
-- v1 stored ids like 'claude-sonnet-4-6' that never existed. Any agent still holding one
-- would fail to launch. Map them onto the alias for their tier; the CLI then resolves the
-- alias to whatever is current, which is the whole point of storing aliases.

UPDATE agents SET model = 'opus'   WHERE model LIKE '%opus%'   AND model <> 'opus';
UPDATE agents SET model = 'sonnet' WHERE model LIKE '%sonnet%' AND model <> 'sonnet';
UPDATE agents SET model = 'haiku'  WHERE model LIKE '%haiku%'  AND model <> 'haiku';
UPDATE agents SET model = 'fable'  WHERE model LIKE '%fable%'  AND model <> 'fable';

-- Anything else unrecognised falls back to the workhorse rather than failing at spawn.
UPDATE agents SET model = 'sonnet'
WHERE model NOT IN ('opus', 'sonnet', 'haiku', 'fable') AND provider = 'claude';

-- The historical resolved id is no longer meaningful for a re-aliased agent; it is
-- repopulated from system/init on the next run.
UPDATE agents SET resolved_model = NULL;
