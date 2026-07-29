import type { Agent } from '@shared/types'
import { describe, expect, it } from 'vitest'
import { learnResolved, plausible, sanitize } from '../src/renderer/src/stores/useResolvedModels'

/**
 * The Sonnet chip that said "Opus 5".
 *
 * The picker learns what an alias resolves to by reading pairs off agent rows — free and exact
 * when the pair is honest. It is not always honest: the two halves are written by different
 * things at different times, and the Pilot row in particular kept `model: 'sonnet'` from the
 * day it was created while every run since had stamped `resolved_model: 'claude-opus-5'` on
 * it. The map is shared across projects and persisted, so that one row relabelled every Sonnet
 * chip in the app, in both directions, for ever.
 */

const agent = (over: Partial<Agent>): Agent =>
  ({
    id: 'a',
    projectId: 'p',
    name: 'Someone',
    role: 'builder',
    provider: 'claude',
    model: 'sonnet',
    effort: null,
    isPilot: false,
    isRoster: true,
    ephemeral: false,
    status: 'idle',
    statusLine: null,
    resolvedModel: null,
    sessionId: null,
    instructions: null,
    avatarInitials: 'SO',
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }) as Agent

describe('what an alias may be taught to mean', () => {
  it('accepts a resolution from the same family', () => {
    expect(plausible('sonnet', 'claude-sonnet-5')).toBe(true)
    expect(plausible('opus', 'claude-opus-5')).toBe(true)
    // A pinned id resolving to a dated build of itself.
    expect(plausible('claude-opus-4-8', 'claude-opus-4-8-20250929')).toBe(true)
  })

  it('refuses one family claiming another', () => {
    expect(plausible('sonnet', 'claude-opus-5')).toBe(false)
    expect(plausible('haiku', 'claude-sonnet-5')).toBe(false)
  })
})

describe('learning from the roster', () => {
  it('learns an honest pair', () => {
    const out = learnResolved([agent({ model: 'opus', resolvedModel: 'claude-opus-5' })])
    expect(out).toEqual({ opus: 'claude-opus-5' })
  })

  /** The exact shape of the reported bug. */
  it('learns nothing from a row that contradicts itself', () => {
    const out = learnResolved([
      agent({ id: 'pilot', isPilot: true, model: 'sonnet', resolvedModel: 'claude-opus-5' }),
    ])
    expect(out).toEqual({})
  })

  it('prefers the most recently updated row', () => {
    const out = learnResolved([
      agent({ id: 'old', model: 'opus', resolvedModel: 'claude-opus-4-8', updatedAt: 1 }),
      agent({ id: 'new', model: 'opus', resolvedModel: 'claude-opus-5', updatedAt: 9 }),
    ])
    expect(out.opus).toBe('claude-opus-5')
  })

  it('ignores a row that only echoes its own pin back', () => {
    const out = learnResolved([
      agent({ model: 'claude-opus-5', resolvedModel: 'claude-opus-5' }),
    ])
    expect(out).toEqual({})
  })
})

describe('healing a map that was already poisoned', () => {
  /*
   * The map is persisted, so the bad entry outlived the bug that created it and crossed
   * projects. Sanitising on read is what makes the fix retroactive rather than only stopping
   * it happening again.
   */
  it('drops the impossible entry and keeps the rest', () => {
    expect(sanitize({ sonnet: 'claude-opus-5', opus: 'claude-opus-5' })).toEqual({
      opus: 'claude-opus-5',
    })
  })
})
