import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeDb, openDb } from '../src/main/db'
import { flushWrites } from '../src/main/db/writer'
import { addProject } from '../src/main/db/repos/projects'
import { createAgent } from '../src/main/db/repos/agents'
import { createTicket, updateTicket } from '../src/main/db/repos/tickets'
import { acceptRoute, proposeRoute, proposedRoute } from '../src/main/db/repos/routes'
import { scan } from '../src/main/engine/heartbeat'

/**
 * Noticing that nothing is happening.
 *
 * The assertion that matters most is the negative one: a healthy project produces **zero**
 * problems, and therefore zero Pilot turns. A heartbeat that says "all good" on a timer costs
 * a full turn on a large context every time and trains you to ignore it — which would make it
 * worse than not having one.
 */

let projectId: string
let builderId: string

beforeAll(() => {
  openDb(join(mkdtempSync(join(tmpdir(), 'vp-db-')), 'test.db'))
  const repo = mkdtempSync(join(tmpdir(), 'vp-repo-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })

  projectId = addProject({ path: repo, name: 'Beat' }).id
  createAgent({
    projectId,
    name: 'Pilot',
    role: 'pilot',
    provider: 'claude',
    model: 'sonnet',
    isPilot: true,
  })
  builderId = createAgent({
    projectId,
    name: 'Robin',
    role: 'builder',
    provider: 'claude',
    model: 'sonnet',
    isRoster: true,
  }).id
})

afterAll(() => {
  flushWrites()
  closeDb()
})

/** A ticket with an accepted route and an active step. */
function started(assign: boolean): { number: number; id: string } {
  const t = createTicket({ projectId, title: 'Do the thing', body: 'x', lane: 'todo' })
  proposeRoute({
    ticketId: t.id,
    projectId,
    rationale: 'r',
    proposedByAgentId: null,
    steps: [
      { kind: 'build', note: null, brief: 'go', assigneeAgentId: assign ? builderId : null },
    ],
  })
  acceptRoute(proposedRoute(t.id)!.id)
  flushWrites()
  return { number: t.number, id: t.id }
}

describe('silence when nothing is wrong', () => {
  it('says nothing about a project with no work at all', () => {
    expect(scan(projectId)).toHaveLength(0)
  })

  it('says nothing about an unrouted ticket — the board covers that', () => {
    createTicket({ projectId, title: 'Someday', body: '', lane: 'backlog' })
    flushWrites()
    expect(scan(projectId)).toHaveLength(0)
  })
})

describe('the stall the Pilot could never see', () => {
  /**
   * A step active with an assignee who holds no process. Before the launch gate this happened
   * whenever two tickets routed to the same teammate — the second launch was dropped and the
   * card waited for ever beside an idle agent. Nothing woke the Pilot, because nothing had
   * happened; that is precisely the point.
   */
  it('reports an assigned step with nothing running it', () => {
    const t = started(true)
    const found = scan(projectId)
    expect(found.some((p) => p.key === `stuck:${t.id}`)).toBe(true)
    expect(found.find((p) => p.key === `stuck:${t.id}`)!.line).toContain(`#${t.number}`)
  })

  it('reports a step with nobody assigned once work before it is done', () => {
    const t = started(false)
    // Unassigned and unstarted is "waiting to be picked up", not a stall — the board says so.
    expect(scan(projectId).some((p) => p.key === `stuck:${t.id}`)).toBe(false)
  })
})

describe('budgets', () => {
  it('does not warn on a ticket with no budget set', () => {
    const t = started(true)
    updateTicket(t.id, { budgetUsd: null })
    flushWrites()
    expect(scan(projectId).some((p) => p.key === `budget:${t.id}`)).toBe(false)
  })
})
