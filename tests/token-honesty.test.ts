import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeDb, openDb } from '../src/main/db'
import { addProject } from '../src/main/db/repos/projects'
import { createAgent, getAgent, recordAgentUsage } from '../src/main/db/repos/agents'
import { totalTokens } from '../src/shared/types'

/**
 * Two lies this suite exists to keep dead.
 *
 * 1. `totalTokens` summed the four usage fields raw. One vibePilot turn is one prompt over
 *    many API round-trips, and each round-trip re-reads the whole conversation as a cache
 *    read — so the raw sum counted the same content once per round-trip. A real research run
 *    whose distinct content was ~225k displayed as 9.27M.
 *
 * 2. `cost_usd` was accumulated with `+`, but the CLI's total_cost_usd is the running total
 *    for the whole process. Every turn re-added everything spent before it. A $2.58 Pilot
 *    displayed $5.71.
 */
describe('token weighting', () => {
  it('weights the four fields rather than summing them raw', () => {
    // Sam's real research run, from the live database.
    const sam = {
      tokensIn: 127,
      tokensOut: 47_153,
      tokensCacheRead: 9_071_496,
      tokensCacheWrite: 154_454,
    }
    const raw = sam.tokensIn + sam.tokensOut + sam.tokensCacheRead + sam.tokensCacheWrite
    expect(raw).toBe(9_273_230)

    // 127 + 235,765 + 907,149.6 + 308,908
    expect(totalTokens(sam)).toBe(1_451_950)

    // The whole point: the honest figure is a fraction of the raw sum.
    expect(totalTokens(sam)).toBeLessThan(raw / 6)
  })

  it('counts output far above cache reads', () => {
    const out = totalTokens({ tokensIn: 0, tokensOut: 1000, tokensCacheRead: 0, tokensCacheWrite: 0 })
    const cached = totalTokens({ tokensIn: 0, tokensOut: 0, tokensCacheRead: 1000, tokensCacheWrite: 0 })
    expect(out).toBe(5000)
    expect(cached).toBe(100)
  })

  it('is zero for an agent that has done nothing', () => {
    expect(totalTokens({ tokensIn: 0, tokensOut: 0, tokensCacheRead: 0, tokensCacheWrite: 0 })).toBe(0)
  })
})

describe('cumulative cost', () => {
  let projectId: string
  let dir: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'vp-cost-'))
    openDb(join(dir, 'test.db'))
    projectId = addProject({ name: 'Cost', path: dir, gitRemote: null, defaultBaseBranch: 'main' }).id
  })

  afterAll(() => closeDb())

  it('replaces the cost rather than adding it', () => {
    const agent = createAgent({
      projectId,
      name: 'Sam',
      role: 'builder',
      provider: 'claude',
      model: 'sonnet',
      instructions: '',
      isPilot: false,
      isRoster: true,
    })

    // Four turns of one CLI process, reporting its RUNNING TOTAL each time.
    for (const costUsd of [0.6430085, 0.907333, 1.5782485, 1.6383485]) {
      recordAgentUsage(agent.id, {
        tokensIn: 1,
        tokensOut: 1,
        cacheRead: 0,
        cacheWrite: 0,
        costUsd,
      })
    }

    // The last reading, not the sum of all four (which would be $4.767).
    expect(getAgent(agent.id)?.costUsd).toBeCloseTo(1.6383485, 6)

    // Tokens, by contrast, genuinely accumulate.
    expect(getAgent(agent.id)?.tokensIn).toBe(4)
  })

  it('does not walk backwards on a zeroed turn', () => {
    const agent = createAgent({
      projectId,
      name: 'Jim',
      role: 'builder',
      provider: 'claude',
      model: 'sonnet',
      instructions: '',
      isPilot: false,
      isRoster: true,
    })
    recordAgentUsage(agent.id, { tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0, costUsd: 2.5 })
    recordAgentUsage(agent.id, { tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 })
    expect(getAgent(agent.id)?.costUsd).toBeCloseTo(2.5, 6)
  })
})

/**
 * The chip beside a message.
 *
 * This one survived the first pass and it is the figure you look at most: a six-step turn on a
 * ~110k conversation read **740k tok** beside a four-paragraph reply, because the four fields
 * were still being summed raw here. Real numbers, from the live database.
 */
describe('a message costs what it costs', () => {
  // The "Done — #2 is on the Branches tab for you" turn.
  const realTurn = {
    tokensIn: 14,
    tokensOut: 2_958,
    tokensCacheRead: 729_128,
    tokensCacheWrite: 8_148,
  }

  it('does not read 740k for one reply', () => {
    const raw =
      realTurn.tokensIn + realTurn.tokensOut + realTurn.tokensCacheRead + realTurn.tokensCacheWrite
    expect(raw, 'what the chip used to show').toBe(740_248)

    // Six round trips re-sending the same ~110k conversation is not 740k of anything.
    expect(totalTokens(realTurn)).toBe(104_013)
    expect(totalTokens(realTurn)).toBeLessThan(raw / 7)
  })

  it('is dominated by cache reads, which is why the weighting matters', () => {
    // 729k of the 740k was the conversation being re-read, once per round trip.
    expect(realTurn.tokensCacheRead / (realTurn.tokensIn + realTurn.tokensOut)).toBeGreaterThan(200)
  })
})
