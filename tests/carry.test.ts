import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeDb, openDb } from '../src/main/db'
import { enqueueWrite, flushWrites } from '../src/main/db/writer'
import { addProject } from '../src/main/db/repos/projects'
import { createAgent } from '../src/main/db/repos/agents'
import { createTicket, getTicket, updateTicket } from '../src/main/db/repos/tickets'
import { decideCarry } from '../src/main/engine/carry'

/**
 * What a finished teammate's context is worth to the next ticket.
 *
 * The rule is mechanical on purpose. Letting the Pilot decide was the user's own suggestion
 * and the tempting answer, but the Pilot only ever sees a teammate's *report* — so it would
 * be judging a summary of a summary, and what it would really be deciding is "are these two
 * tickets related", which is a cheap question answerable from data already on disk.
 */

let projectId: string
let builderId: string
let reviewerId: string

/** A finished run for this agent, on this ticket, at this time. */
function ranOn(agentId: string, ticketId: string | null, sessionId: string, at: number): void {
  enqueueWrite(
    `INSERT INTO agent_runs (id, agent_id, project_id, ticket_id, provider, session_id, started_at)
     VALUES (?,?,?,?,'claude',?,?)`,
    `run-${sessionId}`,
    agentId,
    projectId,
    ticketId,
    sessionId,
    at,
  )
  flushWrites()
}

beforeAll(() => {
  openDb(join(mkdtempSync(join(tmpdir(), 'vp-db-')), 'test.db'))
  const repo = mkdtempSync(join(tmpdir(), 'vp-repo-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })

  projectId = addProject({ path: repo, name: 'Carry' }).id
  builderId = createAgent({
    projectId,
    name: 'Robin',
    role: 'builder',
    provider: 'claude',
    model: 'sonnet',
    isRoster: true,
  }).id
  reviewerId = createAgent({
    projectId,
    name: 'Sam',
    role: 'reviewer',
    provider: 'claude',
    model: 'sonnet',
    isRoster: true,
  }).id
})

afterAll(() => {
  flushWrites()
  closeDb()
})

describe('a reviewer never inherits', () => {
  /**
   * The whole value of a review step is that it has not already convinced itself. There is
   * already a check that a reviewer cannot review its own build; this is that principle
   * applied to memory rather than to authorship.
   */
  it('starts cold even when everything else says carry', async () => {
    const t = createTicket({ projectId, title: 'Check it', body: 'src/a.ts', lane: 'todo' })
    ranOn(reviewerId, t.id, 'sess-reviewer', Date.now())

    const d = await decideCarry({
      projectId,
      agentId: reviewerId,
      role: 'reviewer',
      ticket: getTicket(t.id)!,
      brief: 'review src/a.ts',
    })
    expect(d.sessionId).toBeNull()
    expect(d.why).toContain('convinced itself')
  })
})

describe('the same ticket again', () => {
  it('carries — rework is not a new job', async () => {
    const t = createTicket({ projectId, title: 'Rework me', body: 'x', lane: 'todo' })
    ranOn(builderId, t.id, 'sess-same', Date.now())

    const d = await decideCarry({
      projectId,
      agentId: builderId,
      role: 'builder',
      ticket: getTicket(t.id)!,
      brief: 'fix what the reviewer found',
    })
    expect(d.sessionId).toBe('sess-same')
    expect(d.why).toContain('Same ticket')
  })
})

describe('nothing to carry', () => {
  it('starts cold when the agent has never run', async () => {
    const fresh = createAgent({
      projectId,
      name: 'New',
      role: 'builder',
      provider: 'claude',
      model: 'sonnet',
      isRoster: true,
    })
    const t = createTicket({ projectId, title: 'First job', body: '', lane: 'todo' })

    const d = await decideCarry({
      projectId,
      agentId: fresh.id,
      role: 'builder',
      ticket: t,
      brief: '',
    })
    expect(d.sessionId).toBeNull()
    expect(d.why).toContain('no previous session')
  })
})

describe('the staleness cutoff', () => {
  /**
   * The failure mode this feature risks is an agent that "knows" something which changed two
   * tickets ago and acts on it confidently. That is worse than the cold start it saves, so the
   * cutoff is deliberately blunt: anything older than the last merge is not carried.
   */
  it('refuses a session older than the last merge to base', async () => {
    const merged = createTicket({ projectId, title: 'Landed', body: '', lane: 'todo' })
    updateTicket(merged.id, { mergeState: 'merged', lane: 'done' })
    flushWrites()

    const stale = createAgent({
      projectId,
      name: 'Old',
      role: 'builder',
      provider: 'claude',
      model: 'sonnet',
      isRoster: true,
    })
    const t = createTicket({ projectId, title: 'Next', body: '', lane: 'todo' })
    // Long before that merge.
    ranOn(stale.id, t.id, 'sess-stale', Date.now() - 5 * 86_400_000)

    const d = await decideCarry({
      projectId,
      agentId: stale.id,
      role: 'builder',
      ticket: getTicket(t.id)!,
      brief: '',
    })
    expect(d.sessionId).toBeNull()
    expect(d.why).toContain('predates a merge')
  })
})
