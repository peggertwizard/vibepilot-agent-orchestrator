import { useEffect, useMemo } from 'react'
import type { Agent } from '@shared/types'

/**
 * What each alias currently resolves to, learned for free.
 *
 * An alias like `opus` deliberately means *latest*, which is why we store aliases and not
 * pinned ids — but it also means the picker cannot tell you what you are actually about to
 * run. The CLI has **no model-list command** (checked: `claude --help` has `agents`, `auth`,
 * `doctor`, `mcp`, `plugin`, `project`, `setup-token`, `ultrareview`, `update`, and nothing
 * that enumerates models), so the only way to ask is to start a turn — which costs quota.
 *
 * So we do not ask. Every agent that starts reports its resolved model in `system/init`,
 * which is already persisted on the agent row. Reading the mapping back out of the agents we
 * have run is exact, free, and self-correcting: the day Opus 5.1 ships, the first agent you
 * run on `opus` updates the label.
 *
 * The trade is honest and worth stating: an alias you have **never used** shows no version
 * until you use it once.
 *
 * Persisted to localStorage because agent rows are per-project, and the answer is not.
 */

const KEY = 'vibepilot.resolvedModels'

export type ResolvedModels = Record<string, string>

/**
 * Does this resolved id plausibly belong to this alias?
 *
 * The pair on an agent row can be a lie, because the two halves are written by different
 * things at different times: `model` by whoever last edited the roster, `resolved_model` by
 * the CLI at the start of a run. A row that ran Opus while its `model` column still said
 * `sonnet` taught the whole app that Sonnet means Opus 5 — the alias→resolution map is shared
 * across projects and persisted, so one bad row relabelled every Sonnet chip everywhere.
 *
 * The families are named in the ids (`sonnet` ⊂ `claude-sonnet-5`), so the check is a
 * substring. A pinned id passes trivially against itself. Anything that fails this is a
 * mismatched pair, and the only safe thing to learn from it is nothing.
 */
export function plausible(alias: string, resolved: string): boolean {
  return resolved.toLowerCase().includes(alias.toLowerCase())
}

/**
 * Drop entries that cannot be true.
 *
 * Applied on read, so a map poisoned before this check existed heals itself the next time the
 * app starts rather than persisting a wrong label for ever.
 */
export function sanitize(map: ResolvedModels): ResolvedModels {
  return Object.fromEntries(Object.entries(map).filter(([k, v]) => plausible(k, v)))
}

function read(): ResolvedModels {
  try {
    const raw = localStorage.getItem(KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : {}
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    // Trust nothing from storage: a hand-edited or half-written value must not reach a
    // `--model` argument.
    return sanitize(
      Object.fromEntries(
        Object.entries(parsed as Record<string, unknown>).filter(
          ([k, v]) => typeof k === 'string' && typeof v === 'string' && v.length > 0,
        ),
      ) as ResolvedModels,
    )
  } catch {
    return {}
  }
}

/** Newest first, so a stale row never overwrites what the most recent run reported. */
export function learnResolved(agents: Agent[]): ResolvedModels {
  const out: ResolvedModels = {}
  for (const a of [...agents].sort((x, y) => y.updatedAt - x.updatedAt)) {
    if (!a.resolvedModel || !a.model) continue
    if (a.model === a.resolvedModel) continue // already pinned; nothing to learn
    if (!plausible(a.model, a.resolvedModel)) continue // the row contradicts itself
    if (!out[a.model]) out[a.model] = a.resolvedModel
  }
  return out
}

export function useResolvedModels(agents: Agent[]): ResolvedModels {
  const learned = useMemo(() => learnResolved(agents), [agents])

  useEffect(() => {
    // Written even with nothing new to learn: `read` sanitizes, so this is what flushes an
    // already-poisoned entry out of storage instead of re-cleaning it on every read for ever.
    const merged = { ...read(), ...learned }
    try {
      localStorage.setItem(KEY, JSON.stringify(merged))
    } catch {
      /* storage full or disabled; the in-memory value below still works this session */
    }
  }, [learned])

  // Stored first so aliases from other projects show, then this project's fresher answers.
  return useMemo(() => ({ ...read(), ...learned }), [learned])
}
