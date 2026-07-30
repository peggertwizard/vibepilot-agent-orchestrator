import { describe, expect, it } from 'vitest'
import {
  MODEL_OPTIONS,
  formatTokens,
  isValidModel,
  modelLabel,
  prettyModel,
  providerForModel,
} from '../src/shared/types'

describe('model aliases', () => {
  it('the offered list is aliases only, never pinned ids', () => {
    // v1 hardcoded "claude-sonnet-4-6" — a model that does not exist. The offered list is
    // aliases, so it cannot go stale again. Pinning is a separate, opt-in path: you type a
    // version yourself, and it is never presented as the current best.
    for (const m of MODEL_OPTIONS) {
      expect(m.id).not.toMatch(/^claude-/)
      expect(m.id).not.toMatch(/\d/)
    }
  })
})

describe('prettyModel', () => {
  it('renders what the CLI actually resolved', () => {
    expect(prettyModel('claude-sonnet-5')).toBe('Sonnet 5')
    expect(prettyModel('claude-opus-5')).toBe('Opus 5')
    expect(prettyModel('claude-fable-5')).toBe('Fable 5')
  })

  it('surfaces a large context window', () => {
    expect(prettyModel('claude-opus-5[1m]')).toBe('Opus 5 · 1M')
  })

  it('strips a pinned date suffix', () => {
    expect(prettyModel('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
  })

  it('falls back to the alias label before the model has started', () => {
    expect(prettyModel(null, 'sonnet')).toBe('Sonnet')
    expect(prettyModel(undefined, 'haiku')).toBe('Haiku')
  })

  it('does not invent a name it cannot parse', () => {
    expect(prettyModel(null, 'something-custom')).toBe('something-custom')
  })
})

describe('formatTokens', () => {
  it('reads at a glance across magnitudes', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(842)).toBe('842')
    expect(formatTokens(1500)).toBe('1.5k')
    expect(formatTokens(42_000)).toBe('42k')
    expect(formatTokens(1_450_000)).toBe('1.45M')
  })
})

/**
 * Aliases are the default because they never go stale — v1 hardcoded ids and ended up
 * offering models that did not exist. But an alias always means *latest*, so pinning is the
 * escape hatch for holding a teammate on one version. Both paths have to reach `--model`,
 * which accepts either.
 */
describe('model identity', () => {
  it('offers every alias the CLI actually resolves', () => {
    // Verified against `claude --model <alias> --print`: fable -> claude-fable-5,
    // opus -> claude-opus-5, sonnet -> claude-sonnet-5, haiku -> claude-haiku-4-5-*.
    const claude = MODEL_OPTIONS.filter((m) => m.provider === 'claude').map((m) => m.id)
    expect(claude).toEqual(['opus', 'sonnet', 'fable', 'haiku'])
  })

  it('accepts a pinned version as well as an alias', () => {
    expect(isValidModel('sonnet')).toBe(true)
    expect(isValidModel('claude-opus-4-8')).toBe(true)
    expect(isValidModel('claude-fable-5')).toBe(true)
    expect(isValidModel('claude-haiku-4-5-20251001')).toBe(true)
    // The 1M-context suffix the CLI reports back must round-trip.
    expect(isValidModel('claude-opus-5[1m]')).toBe(true)
  })

  it('rejects a typo before it reaches the CLI', () => {
    expect(isValidModel('')).toBe(false)
    expect(isValidModel('opus-5')).toBe(false)
    expect(isValidModel('gpt-4')).toBe(false)
    expect(isValidModel('claude')).toBe(false)
    // A shell metacharacter must never look like a model name.
    expect(isValidModel('claude-opus-5; rm -rf /')).toBe(false)
  })

  it('labels a pinned model readably rather than echoing the raw id', () => {
    expect(modelLabel('sonnet')).toBe('Sonnet')
    expect(modelLabel('fable')).toBe('Fable')
    expect(modelLabel('claude-opus-4-8')).toBe('Opus 4.8')
    expect(modelLabel('claude-fable-5')).toBe('Fable 5')
  })

  it('knows which provider a model belongs to, and defaults to Claude', () => {
    expect(providerForModel('codex')).toBe('codex')
    expect(providerForModel('opus')).toBe('claude')
    // A pinned Claude id is still Claude.
    expect(providerForModel('claude-opus-4-8')).toBe('claude')
  })
})
