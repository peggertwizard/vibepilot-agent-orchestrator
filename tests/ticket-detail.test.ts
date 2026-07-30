import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeDb, id, now, openDb, run } from '../src/main/db'
import { addProject } from '../src/main/db/repos/projects'
import { createAgent } from '../src/main/db/repos/agents'
import { createTicket, ticketSpend } from '../src/main/db/repos/tickets'
import { totalTokens } from '../src/shared/types'

/**
 * What a ticket cost.
 *
 * Per-ticket spend has been derivable all along — `usage_events.ticket_id` is populated for
 * teammate turns — and it was never derived. Two corrections stand between the ledger and a
 * number you can show someone, and they are the same two plan 08 fixed for agents.
 */
describe('ticket spend', () => {
  let projectId: string
  let agentId: string
  let ticketId: string

  const turn = (
    runId: string,
    cumulativeCost: number,
    tokens: { in: number; out: number; read: number; write: number },
  ): void => {
    run(
      `INSERT INTO usage_events
         (id, project_id, agent_id, run_id, ticket_id, provider, model,
          input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
          cost_usd, cost_source, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id(),
      projectId,
      agentId,
      runId,
      ticketId,
      'claude',
      'sonnet',
      tokens.in,
      tokens.out,
      tokens.read,
      tokens.write,
      cumulativeCost,
      'provider',
      now(),
    )
  }

  beforeAll(() => {
    openDb(join(mkdtempSync(join(tmpdir(), 'vp-detail-')), 'test.db'))
    projectId = addProject({ path: mkdtempSync(join(tmpdir(), 'vp-dproj-')), name: 'D' }).id
    agentId = createAgent({
      projectId,
      name: 'Sam',
      role: 'builder',
      provider: 'claude',
      model: 'sonnet',
    }).id
    ticketId = createTicket({ projectId, title: 'Fix the cookie sentence' }).id
  })

  afterAll(() => closeDb())

  it('is zero for a ticket nobody has worked', () => {
    expect(ticketSpend(ticketId)).toEqual({
      costUsd: 0,
      tokensIn: 0,
      tokensOut: 0,
      tokensCacheRead: 0,
      tokensCacheWrite: 0,
      turns: 0,
    })
  })

  it('takes MAX per run, because cost_usd is cumulative per CLI process', () => {
    // One run, three turns. The CLI reports the running total each time, so a naive SUM would
    // charge the first turn three times over: 0.10 + 0.35 + 0.90 = $1.35 for $0.90 of work.
    turn('run-a', 0.1, { in: 10, out: 5, read: 0, write: 100 })
    turn('run-a', 0.35, { in: 12, out: 8, read: 900, write: 0 })
    turn('run-a', 0.9, { in: 14, out: 40, read: 1800, write: 0 })

    expect(ticketSpend(ticketId).costUsd).toBeCloseTo(0.9, 6)
    expect(ticketSpend(ticketId).turns).toBe(3)
  })

  it('adds runs together, since each process reports its own running total', () => {
    turn('run-b', 0.25, { in: 5, out: 5, read: 0, write: 50 })
    turn('run-b', 0.6, { in: 6, out: 9, read: 400, write: 0 })

    // $0.90 from the first process plus $0.60 from the second.
    expect(ticketSpend(ticketId).costUsd).toBeCloseTo(1.5, 6)
  })

  it('keeps the four raw token fields, so the counting happens in one place', () => {
    const s = ticketSpend(ticketId)

    expect(s.tokensIn).toBe(10 + 12 + 14 + 5 + 6)
    expect(s.tokensOut).toBe(5 + 8 + 40 + 5 + 9)
    expect(s.tokensCacheRead).toBe(900 + 1800 + 400)
    expect(s.tokensCacheWrite).toBe(150)

    /*
     * A ticket shows the same figure its agents do: every distinct token counted once. Cache
     * reads are the conversation re-sent per round-trip — counting them is where the 41×
     * inflation came from, 225k of distinct content reading as 9.27M.
     */
    const shown = totalTokens(s)
    const raw = s.tokensIn + s.tokensOut + s.tokensCacheRead + s.tokensCacheWrite

    expect(shown).toBe(s.tokensIn + s.tokensOut)
    expect(shown, 'the re-reads dominate the raw sum').toBeLessThan(raw / 3)
  })

  it("counts only this ticket's work, not the project's", () => {
    const other = createTicket({ projectId, title: 'Something else' })
    const before = ticketSpend(ticketId).costUsd

    run(
      `INSERT INTO usage_events
         (id, project_id, agent_id, run_id, ticket_id, provider, model, cost_usd, cost_source, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      id(),
      projectId,
      agentId,
      'run-c',
      other.id,
      'claude',
      'sonnet',
      99,
      'provider',
      now(),
    )

    expect(ticketSpend(ticketId).costUsd).toBeCloseTo(before, 6)
    expect(ticketSpend(other.id).costUsd).toBe(99)
  })

  it("leaves the Pilot's turns out, because they carry no ticket_id at all", () => {
    const before = ticketSpend(ticketId)

    // This is what `pilot.ts` writes: no ticket_id on the insert. The Pilot's routing and
    // briefing overhead is genuinely not attributable, so a ticket shows what the TEAM spent
    // on it. The UI says so rather than quietly under-reporting.
    run(
      `INSERT INTO usage_events
         (id, project_id, agent_id, run_id, provider, model, cost_usd, cost_source, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      id(),
      projectId,
      agentId,
      'run-pilot',
      'claude',
      'opus',
      4.5,
      'provider',
      now(),
    )

    expect(ticketSpend(ticketId)).toEqual(before)
  })
})
