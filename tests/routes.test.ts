import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeDb, openDb } from '../src/main/db'
import { addProject } from '../src/main/db/repos/projects'
import { createTicket, getTicket } from '../src/main/db/repos/tickets'
import {
  acceptRoute,
  acceptedRoute,
  assignStep,
  completeActiveStep,
  maxPasses,
  proposeRoute,
  proposedRoute,
  reworkTo,
  setBacklogOrder,
  unroutedTickets,
  waitingTickets,
} from '../src/main/db/repos/routes'
import { activeStep, routeSummary } from '../src/shared/types'

/**
 * Routing is the change that undoes v1's central mistake: every ticket walked the same four
 * stages. These lock in that a route is per-ticket, that `tickets.stage` can only ever be a
 * mirror of the live step, and that a failed review sends work back rather than forward.
 */
describe('per-ticket routing', () => {
  let projectId: string

  const newTicket = (title: string): string =>
    createTicket({ projectId, title, lane: 'backlog' }).id

  beforeAll(() => {
    openDb(join(mkdtempSync(join(tmpdir(), 'vp-routes-')), 'test.db'))
    projectId = addProject({ path: mkdtempSync(join(tmpdir(), 'vp-rproj-')), name: 'Routes' }).id
  })

  afterAll(() => closeDb())

  it('a ticket starts unrouted, and says so', () => {
    const id = newTicket('Fix the footer typo')
    expect(acceptedRoute(id)).toBeNull()
    expect(unroutedTickets(projectId).map((t) => t.id)).toContain(id)
  })

  it('routes differ per ticket — there is no shared pipeline', () => {
    const question = newTicket('Which file handles session expiry?')
    const migration = newTicket('Migrate auth to the new provider')

    acceptRoute(
      proposeRoute({
        ticketId: question,
        projectId,
        steps: [{ kind: 'research' }],
        rationale: 'A question. Nothing to build.',
        proposedByAgentId: null,
      }).id,
      undefined,
      true,
    )
    acceptRoute(
      proposeRoute({
        ticketId: migration,
        projectId,
        steps: [{ kind: 'plan' }, { kind: 'build' }, { kind: 'review' }],
        rationale: 'Hard to undo, and it touches auth.',
        proposedByAgentId: null,
      }).id,
    )

    expect(routeSummary(acceptedRoute(question)!.steps)).toBe('Research')
    expect(routeSummary(acceptedRoute(migration)!.steps)).toBe('Plan → Build → Review')
    // A research ticket never enters a build stage at all — that was the whole complaint.
    expect(getTicket(question)!.stage).toBe('research')
  })

  it('accepting a route starts it, and the ticket stage mirrors the live step', () => {
    const id = newTicket('Add a dark mode toggle')
    const r = proposeRoute({
      ticketId: id,
      projectId,
      steps: [{ kind: 'build' }, { kind: 'review', note: 'It is visual.' }],
      rationale: 'Visual change; a builder cannot see its own blind spots.',
      proposedByAgentId: null,
    })

    // Proposed is not started: nothing is active and the board shows no stage.
    expect(getTicket(id)!.stage).toBeNull()
    expect(proposedRoute(id)).toBeTruthy()

    acceptRoute(r.id)
    expect(activeStep(acceptedRoute(id))!.kind).toBe('build')
    expect(getTicket(id)!.stage).toBe('build')

    completeActiveStep(id)
    expect(activeStep(acceptedRoute(id))!.kind).toBe('review')
    expect(getTicket(id)!.stage, 'the mirror follows without anyone writing it').toBe('review')
  })

  it('finishing the last step ends the route rather than inventing another', () => {
    const id = newTicket('Bump the copyright year')
    acceptRoute(
      proposeRoute({
        ticketId: id,
        projectId,
        steps: [{ kind: 'build' }],
        rationale: 'One character.',
        proposedByAgentId: null,
      }).id,
    )
    const out = completeActiveStep(id)
    expect(out!.routeComplete).toBe(true)
    expect(out!.next).toBeNull()
    expect(getTicket(id)!.stage).toBeNull()
  })

  it('a failed review sends the SAME step back and counts the pass', () => {
    const id = newTicket('Restyle the pricing table')
    acceptRoute(
      proposeRoute({
        ticketId: id,
        projectId,
        steps: [{ kind: 'build' }, { kind: 'review' }],
        rationale: 'Visual.',
        proposedByAgentId: null,
      }).id,
    )
    completeActiveStep(id) // build -> review

    reworkTo(id, 'build')
    const r = acceptedRoute(id)!
    const build = r.steps.find((s) => s.kind === 'build')!
    const review = r.steps.find((s) => s.kind === 'review')!

    expect(build.status).toBe('rework')
    expect(build.passes).toBe(2)
    // The review that already passed must run again against the new code.
    expect(review.status).toBe('pending')
    expect(maxPasses(r)).toBe(2)
    expect(getTicket(id)!.stage).toBe('build')

    // And rework completes forward normally — it is a status, not a dead end.
    completeActiveStep(id)
    expect(activeStep(acceptedRoute(id))!.kind).toBe('review')
  })

  it('a second proposal supersedes the first instead of stacking cards', () => {
    const id = newTicket('Add a health endpoint')
    proposeRoute({
      ticketId: id,
      projectId,
      steps: [{ kind: 'plan' }, { kind: 'build' }],
      rationale: 'First thought.',
      proposedByAgentId: null,
    })
    const second = proposeRoute({
      ticketId: id,
      projectId,
      steps: [{ kind: 'build' }],
      rationale: 'On reflection, it is one handler.',
      proposedByAgentId: null,
    })
    expect(proposedRoute(id)!.id).toBe(second.id)
  })

  it('accepting with edited steps stores what the user agreed to, not what was proposed', () => {
    const id = newTicket('Rename the settings label')
    const r = proposeRoute({
      ticketId: id,
      projectId,
      steps: [{ kind: 'plan' }, { kind: 'build' }, { kind: 'review' }],
      rationale: 'Being careful.',
      proposedByAgentId: null,
    })
    acceptRoute(r.id, [{ kind: 'build' }])
    expect(routeSummary(acceptedRoute(id)!.steps)).toBe('Build')
  })

  /**
   * Where work waits. Deliberately derived from the route rather than held in a queue table:
   * a queue would have to stay in sync with route status, lane, dependencies and the roster,
   * and this codebase already learned that lesson with tickets.stage.
   */
  it('reports an accepted route whose active step has nobody on it', () => {
    const id = newTicket('Fix the nav overlap')
    const r = proposeRoute({
      ticketId: id,
      projectId,
      steps: [{ kind: 'build' }, { kind: 'review' }],
      rationale: 'Visual work earns a second pair of eyes.',
      proposedByAgentId: null,
    })
    acceptRoute(r.id)

    const waiting = waitingTickets(projectId)
    expect(waiting.map((w) => w.id)).toContain(id)
    expect(waiting.find((w) => w.id === id)!.kind).toBe('build')

    // Once somebody is on it, it is no longer waiting.
    assignStep(id, acceptedRoute(id)!.steps[0]!.id, 'agent-1')
    expect(waitingTickets(projectId).map((w) => w.id)).not.toContain(id)

    // And when the build finishes, the review step is waiting in its turn.
    completeActiveStep(id)
    const after = waitingTickets(projectId)
    expect(after.find((w) => w.id === id)?.kind).toBe('review')
  })

  it('does not count an unrouted ticket as waiting', () => {
    const id = newTicket('Nobody has decided how to do this')
    expect(waitingTickets(projectId).map((w) => w.id)).not.toContain(id)
  })

  it('the backlog carries the order the Pilot proposed', () => {
    const a = createTicket({ projectId, title: 'Later', lane: 'backlog' })
    const b = createTicket({ projectId, title: 'Sooner', lane: 'backlog' })
    setBacklogOrder(projectId, [b.number, a.number])
    expect(getTicket(b.id)!.backlogRank).toBe(1)
    expect(getTicket(a.id)!.backlogRank).toBe(2)
  })
})
