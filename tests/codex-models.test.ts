import { describe, expect, it } from 'vitest'
import { parseModelList, codexEffort } from '../src/main/providers/codex/models'
import { CODEX_PREFIX, codexModelId, providerForModel, isValidModel, vpEffort } from '@shared/types'

/**
 * The model list, as codex-cli 0.145.0 actually answers it.
 *
 * Captured from a real `codex app-server` → `model/list` on the development machine and trimmed
 * to the fields that are read. A handwritten fixture would only prove the parser agrees with
 * whatever shape was imagined while writing it; this one came off the wire.
 */
const REAL_REPLY = {
  id: 2,
  result: {
    data: [
      {
        id: 'gpt-5.6-sol',
        model: 'gpt-5.6-sol',
        displayName: 'GPT-5.6-Sol',
        description: 'Latest frontier agentic coding model.',
        hidden: false,
        supportedReasoningEfforts: [
          { reasoningEffort: 'low', description: 'Fast responses with lighter reasoning' },
          { reasoningEffort: 'medium', description: 'Balances speed and reasoning depth' },
          { reasoningEffort: 'high', description: 'Greater reasoning depth' },
          { reasoningEffort: 'xhigh', description: 'Extra high reasoning depth' },
          { reasoningEffort: 'max', description: 'Maximum reasoning depth' },
          { reasoningEffort: 'ultra', description: 'Maximum reasoning with task delegation' },
        ],
        defaultReasoningEffort: 'low',
        isDefault: true,
      },
      {
        id: 'gpt-5.4-mini',
        model: 'gpt-5.4-mini',
        displayName: 'GPT-5.4-Mini',
        description: 'Smaller and faster.',
        hidden: false,
        supportedReasoningEfforts: [
          { reasoningEffort: 'low' },
          { reasoningEffort: 'medium' },
          { reasoningEffort: 'high' },
          { reasoningEffort: 'xhigh' },
        ],
        defaultReasoningEffort: 'medium',
        isDefault: false,
      },
      {
        id: 'gpt-4-retired',
        displayName: 'Retired',
        hidden: true,
        supportedReasoningEfforts: [],
        defaultReasoningEffort: null,
        isDefault: false,
      },
    ],
  },
}

describe('asking Codex which models it has', () => {
  it('reads the real reply', () => {
    const models = parseModelList(REAL_REPLY)
    expect(models.map((m) => m.id)).toEqual(['gpt-5.6-sol', 'gpt-5.4-mini'])

    const sol = models[0]!
    expect(sol.label).toBe('GPT-5.6-Sol')
    expect(sol.description).toBe('Latest frontier agentic coding model.')
    expect(sol.isDefault).toBe(true)
    expect(sol.defaultEffort).toBe('low')
  })

  /** Hidden is how OpenAI retires a model without breaking anyone's config. Trust it. */
  it('leaves out the models the CLI hides', () => {
    expect(parseModelList(REAL_REPLY).map((m) => m.id)).not.toContain('gpt-4-retired')
  })

  /**
   * The efforts differ per model, which is the reason to ask at all rather than assume one
   * ladder. Offering `max` on a model that rejects it turns a click into a failed launch.
   */
  it('keeps each model’s own effort list', () => {
    const [sol, mini] = parseModelList(REAL_REPLY)
    expect(sol!.efforts).toContain('ultra')
    expect(mini!.efforts).not.toContain('ultra')
    expect(mini!.efforts).not.toContain('max')
  })

  /**
   * A later codex-cli may rename or drop any of this. Fewer models in the picker is a survivable
   * outcome; throwing on the path that decides whether a teammate can be hired is not.
   */
  it('returns nothing rather than throwing on a shape it does not know', () => {
    expect(parseModelList(null)).toEqual([])
    expect(parseModelList({})).toEqual([])
    expect(parseModelList({ result: { data: 'not an array' } })).toEqual([])
    expect(parseModelList({ result: { data: [{ no: 'id' }, { id: 42 }] } })).toEqual([])
  })

  it('survives a model with no efforts and no description', () => {
    const models = parseModelList({ result: { data: [{ id: 'bare' }] } })
    expect(models).toEqual([
      { id: 'bare', label: 'bare', description: '', efforts: [], defaultEffort: null, isDefault: false },
    ])
  })
})

/**
 * The two ladders are the same one, renamed at the top.
 *
 * vibePilot's `ultracode` and Codex's `ultra` were arrived at independently and mean the same
 * thing — the CLI describes `ultra` as maximum reasoning with automatic task delegation, which
 * is what `ultracode` has always meant here.
 */
describe('effort names', () => {
  it('maps ultracode to ultra and leaves the rest alone', () => {
    expect(codexEffort('ultracode')).toBe('ultra')
    for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) {
      expect(codexEffort(level)).toBe(level)
    }
  })

  it('maps back the other way', () => {
    expect(vpEffort('ultra')).toBe('ultracode')
    expect(vpEffort('high')).toBe('high')
  })
})

/**
 * Which adapter a teammate is launched through.
 *
 * Decided by the stored string, so it has to be decidable *from* the string. Before the prefix,
 * the provider was found by looking the model up in `MODEL_OPTIONS` — a list that by definition
 * cannot contain a discovered Codex id, so a teammate on `gpt-5.6-sol` would have been launched
 * through the Claude adapter.
 */
describe('a Codex model is recognisable as one', () => {
  it('routes a discovered model to the Codex provider', () => {
    expect(providerForModel(`${CODEX_PREFIX}gpt-5.6-sol`)).toBe('codex')
    expect(providerForModel('codex')).toBe('codex')
    expect(providerForModel('opus')).toBe('claude')
    expect(providerForModel('claude-opus-4-8')).toBe('claude')
  })

  it('hands the bare id to the CLI', () => {
    expect(codexModelId(`${CODEX_PREFIX}gpt-5.6-sol`)).toBe('gpt-5.6-sol')
    // No specific model chosen — Codex uses its own default, and no -m is passed.
    expect(codexModelId('codex')).toBeNull()
    expect(codexModelId('opus')).toBeNull()
  })

  it('accepts one as a valid model to save on a teammate', () => {
    expect(isValidModel(`${CODEX_PREFIX}gpt-5.6-sol`)).toBe(true)
    expect(isValidModel(`${CODEX_PREFIX}`)).toBe(false)
  })
})
