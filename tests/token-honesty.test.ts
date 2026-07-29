import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeDb, openDb } from '../src/main/db'
import { addProject } from '../src/main/db/repos/projects'
import { createAgent, getAgent, recordAgentUsage } from '../src/main/db/repos/agents'
import { totalTokens, weightedTokens } from '../src/shared/types'

/**
 * Three lies this suite exists to keep dead.
 *
 * 1. `totalTokens` summed the four usage fields raw. One vibePilot turn is one prompt over
 *    many API round-trips, and each round-trip re-reads the whole conversation as a cache
 *    read — so the raw sum counted the same content once per round-trip. A real research run
 *    whose distinct content was ~225k displayed as 9.27M.
 *
 * 2. The fix for that was a *weighted* figure (`out × 5`, `cacheRead × 0.1`, `cacheWrite × 2`),
 *    which is a fair proxy for what usage costs against a rate limit — but it was labelled
 *    "tok". A cost proxy wearing a token label is still a wrong number: a Pilot that had put
 *    136k through a model read 645k. The two are now separate functions and only one of them
 *    is ever called tokens.
 *
 * 3. `cost_usd` was accumulated with `+`, but the CLI's total_cost_usd is the running total
 *    for the whole process. Every turn re-added everything spent before it. A $2.58 Pilot
 *    displayed $5.71.
 */
describe('counting tokens', () => {
  // A real research run, from the live database.
  const sam = {
    tokensIn: 127,
    tokensOut: 47_153,
    tokensCacheRead: 9_071_496,
    tokensCacheWrite: 154_454,
  }

  it('counts each distinct token once, and cache reads not at all', () => {
    const raw = sam.tokensIn + sam.tokensOut + sam.tokensCacheRead + sam.tokensCacheWrite
    expect(raw, 'what it used to show').toBe(9_273_230)

    // 127 sent + 47,153 written back + 154,454 newly cached.
    expect(totalTokens(sam)).toBe(201_734)

    // The 9.07M of cache reads is that same ~154k of context, re-sent about 59 times.
    expect(Math.round(sam.tokensCacheRead / sam.tokensCacheWrite)).toBe(59)
  })

  it('does not let a long conversation inflate a short turn', () => {
    const short = { tokensIn: 10, tokensOut: 90, tokensCacheWrite: 0 }
    const sameTurnLaterOn = { ...short, tokensCacheRead: 2_000_000 }

    // Identical work, a much bigger conversation behind it. Same number.
    expect(totalTokens({ ...short, tokensCacheRead: 0 })).toBe(100)
    expect(totalTokens(sameTurnLaterOn)).toBe(100)
  })

  it('is zero for an agent that has done nothing', () => {
    expect(totalTokens({ tokensIn: 0, tokensOut: 0, tokensCacheRead: 0, tokensCacheWrite: 0 })).toBe(0)
  })

  /**
   * The weighting still exists — it is genuinely the right answer to "what did this cost me
   * against my rate limit". It just must never be labelled tokens.
   */
  it('keeps the cost proxy available, and separate', () => {
    expect(weightedTokens(sam)).toBe(1_451_950)
    expect(weightedTokens(sam)).toBeGreaterThan(totalTokens(sam) * 7)

    const out = weightedTokens({ tokensIn: 0, tokensOut: 1000, tokensCacheRead: 0, tokensCacheWrite: 0 })
    const cached = weightedTokens({ tokensIn: 0, tokensOut: 0, tokensCacheRead: 1000, tokensCacheWrite: 0 })
    expect(out).toBe(5000)
    expect(cached).toBe(100)
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
    expect(raw, 'what the chip showed first').toBe(740_248)

    // Then it showed 104,013 — the weighted figure, which is a cost proxy and not a count.
    expect(weightedTokens(realTurn)).toBe(104_013)

    // 14 sent + 2,958 written back + 8,148 newly cached. That is the whole turn.
    expect(totalTokens(realTurn)).toBe(11_120)
    expect(totalTokens(realTurn)).toBeLessThan(raw / 60)
  })

  it('is dominated by cache reads, which is why they are not counted', () => {
    // 729k of the 740k was the conversation being re-read, once per round trip.
    expect(realTurn.tokensCacheRead / (realTurn.tokensIn + realTurn.tokensOut)).toBeGreaterThan(200)
  })
})
