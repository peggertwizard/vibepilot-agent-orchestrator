-- 006 — memory: provenance, supersession, and the fact that the index is derived.
--
-- The markdown files under .vibepilot/memory/ are the source of truth. Everything in this
-- table can be thrown away and rebuilt from them, and there is a test that proves it. That
-- separation — storage in files, search in SQLite — is the single decision this design
-- turns on: files are diffable, reviewable and hand-editable, and FTS is neither.

-- Where this entry came from, so a re-index can find it again and a human can go edit it.
ALTER TABLE memory_entries ADD COLUMN file TEXT NOT NULL DEFAULT '';
ALTER TABLE memory_entries ADD COLUMN slug TEXT NOT NULL DEFAULT '';

-- 'user' outranks everything and is never expired by the curator: it is the one signal that
-- cannot be re-derived by reading the code.
ALTER TABLE memory_entries ADD COLUMN source TEXT NOT NULL DEFAULT 'agent';

-- Free text, not a foreign key: the agent that learned this may be long gone, and the name
-- is what a human reading the file wants to see.
ALTER TABLE memory_entries ADD COLUMN author TEXT;

-- Which agent's own file this belongs to. NULL for project-wide memory.
ALTER TABLE memory_entries ADD COLUMN agent_scope TEXT;

-- The repo files this entry is about. Staleness is the unsolved problem in agent memory —
-- an entry that was true becomes confidently wrong. Recording what it concerns lets the
-- curator flag it for re-verification when those files change, instead of trusting it.
ALTER TABLE memory_entries ADD COLUMN concerns_json TEXT NOT NULL DEFAULT '[]';

-- Superseded rather than deleted, so you can see what we used to believe.
ALTER TABLE memory_entries ADD COLUMN superseded_by TEXT;
ALTER TABLE memory_entries ADD COLUMN needs_review INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_memory_scope ON memory_entries(project_id, agent_scope);
CREATE INDEX idx_memory_file ON memory_entries(project_id, file);
