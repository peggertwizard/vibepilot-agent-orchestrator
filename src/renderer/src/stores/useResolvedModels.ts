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

function read(): ResolvedModels {
  try {
    const raw = localStorage.getItem(KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : {}
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    // Trust nothing from storage: a hand-edited or half-written value must not reach a
    // `--model` argument.
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        ([k, v]) => typeof k === 'string' && typeof v === 'string' && v.length > 0,
      ),
    ) as ResolvedModels
  } catch {
    return {}
  }
}

export function useResolvedModels(agents: Agent[]): ResolvedModels {
  // Newest first, so a stale row never overwrites what the most recent run reported.
  const learned = useMemo(() => {
    const out: ResolvedModels = {}
    for (const a of [...agents].sort((x, y) => y.updatedAt - x.updatedAt)) {
      if (!a.resolvedModel || !a.model) continue
      if (a.model === a.resolvedModel) continue // already pinned; nothing to learn
      if (!out[a.model]) out[a.model] = a.resolvedModel
    }
    return out
  }, [agents])

  useEffect(() => {
    if (Object.keys(learned).length === 0) return
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
