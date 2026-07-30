import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeDb, openDb } from '../src/main/db'
import { addProject } from '../src/main/db/repos/projects'
import { addMessage, listMessages } from '../src/main/db/repos/messages'

/**
 * Per-answer usage.
 *
 * `agents.tokens_*` are cumulative and answer "what has this agent spent in total", which is
 * the wrong question when you are looking at one reply and wondering why it was expensive.
 *
 * The first test here exists because adding these four columns broke every tool in the app:
 * the column list grew and the placeholder list did not, so every addMessage threw and four
 * unrelated suites went red at once. A round-trip test catches that class of bug instantly.
 */
describe('per-message usage', () => {
  let projectId: string

  beforeAll(() => {
    openDb(join(mkdtempSync(join(tmpdir(), 'vp-mu-')), 'test.db'))
    projectId = addProject({ path: mkdtempSync(join(tmpdir(), 'vp-muproj-')), name: 'Usage' }).id
  })

  afterAll(() => closeDb())

  it('round-trips every column it writes', () => {
    const m = addMessage({
      projectId,
      authorType: 'agent',
      body: 'hello',
      usage: {
        inputTokens: 120,
        outputTokens: 45,
        cacheReadTokens: 9000,
        cacheCreationTokens: 300,
      },
    })
    expect(m.body).toBe('hello')
    expect(m.usage).toEqual({
      inputTokens: 120,
      outputTokens: 45,
      cacheReadTokens: 9000,
      cacheCreationTokens: 300,
    })
    // And it survives a re-read, which is what the UI actually does.
    const again = listMessages(projectId).find((x) => x.id === m.id)!
    expect(again.usage?.inputTokens).toBe(120)
  })

  it('is null, not zero, when the turn never reported', () => {
    // A killed turn produces a message with no figure. Rendering that as "0 tok" would be a
    // confident lie about a number the user reads to make a decision.
    const m = addMessage({ projectId, authorType: 'agent', body: 'interrupted' })
    expect(m.usage).toBeNull()
  })

  it('still writes messages that carry no usage at all', () => {
    // The regression: every system notice, error and comm goes through this path too.
    expect(() =>
      addMessage({ projectId, authorType: 'system', kind: 'notice', body: 'merged' }),
    ).not.toThrow()
    expect(listMessages(projectId).length).toBeGreaterThanOrEqual(3)
  })
})
