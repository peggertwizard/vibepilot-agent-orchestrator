import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeDb, openDb } from '../src/main/db'
import { addProject } from '../src/main/db/repos/projects'
import { createAgent } from '../src/main/db/repos/agents'
import { createTicket, getTicket } from '../src/main/db/repos/tickets'
import { acceptRoute, acceptedRoute, assignStep, proposeRoute } from '../src/main/db/repos/routes'
import { addFindings, listFindings, renderFindings, resolveFindings } from '../src/main/db/repos/findings'
import { callTool } from '../src/main/mcp/tools'
import { MAX_REVIEW_PASSES, activeStep } from '../src/shared/types'

/**
 * v1 conflated "does it run" with "is it right". They are different jobs: the first is the
 * builder's and is nearly free, the second needs someone who did not write the code.
 *
 * The rework loop is the part with teeth. A failed review must send the SAME step back to
 * the SAME builder — not open a ticket, not hire a replacement — and it must stop rather
 * than ping-pong forever.
 */
describe('review and rework', () => {
  let projectId: string
  let pilotId: string
  let builderId: string
  let reviewerId: string

  /** A ticket already routed [build, review], with build finished and review live. */
  const readyForReview = (title: string): string => {
    const t = createTicket({ projectId, title, lane: 'in_progress' })
    const r = acceptRoute(
      proposeRoute({
        ticketId: t.id,
        projectId,
        steps: [{ kind: 'build' }, { kind: 'review' }],
        rationale: 'Visual.',
        proposedByAgentId: pilotId,
      }).id,
    )!
    assignStep(t.id, r.steps[0]!.id, builderId)
    assignStep(t.id, r.steps[1]!.id, reviewerId)
    // Walk the build step to done so the review is what is live.
    const route = acceptedRoute(t.id)!
    void route
    return t.id
  }

  beforeAll(() => {
    openDb(join(mkdtempSync(join(tmpdir(), 'vp-review-')), 'test.db'))
    projectId = addProject({ path: mkdtempSync(join(tmpdir(), 'vp-rvproj-')), name: 'Review' }).id
    pilotId = createAgent({ projectId, name: 'Pilot', role: 'pilot', provider: 'claude', model: 'sonnet', isPilot: true }).id
    builderId = createAgent({ projectId, name: 'Dana', role: 'builder', provider: 'claude', model: 'sonnet' }).id
    reviewerId = createAgent({ projectId, name: 'Rae', role: 'reviewer', provider: 'claude', model: 'sonnet' }).id
  })

  afterAll(() => closeDb())

  const advance = async (ticketNumber: number, agentId: string, role: 'builder' | 'reviewer') =>
    callTool(
      'advance_step',
      { ticket: ticketNumber, result: 'done' },
      { runId: 'r', agentId, projectId, ticketId: null, role },
    )

  const fail = async (ticketNumber: number, findings: unknown[]) =>
    callTool(
      'review_failed',
      { ticket: ticketNumber, findings, verdict: 'Not right yet.' },
      { runId: 'r', agentId: reviewerId, projectId, ticketId: null, role: 'reviewer' },
    )

  it('refuses to fail a review on a ticket that is not being reviewed', async () => {
    const id = readyForReview('Still building')
    const n = getTicket(id)!.number
    // The build step is still live, so there is no review to fail.
    const res = await fail(n, [{ summary: 'nope' }])
    expect(res.structuredContent?.['ok']).toBe(false)
    expect(String(res.content[0]?.text)).toContain('not on a review step')
  })

  it('sends the same step back to the same builder, and does not create a ticket', async () => {
    const id = readyForReview('Restyle the pricing table')
    const n = getTicket(id)!.number
    await advance(n, builderId, 'builder')
    expect(activeStep(acceptedRoute(id))!.kind).toBe('review')

    const res = await fail(n, [
      { severity: 'must', summary: 'The total column overlaps at 320px.', file: 'src/Pricing.tsx', line: 44 },
      { severity: 'nit', summary: 'Inconsistent capitalisation on the CTA.' },
    ])
    expect(res.structuredContent?.['ok']).toBe(true)
    expect(res.structuredContent?.['pass']).toBe(2)

    const route = acceptedRoute(id)!
    const live = activeStep(route)!
    expect(live.kind, 'back to build, not forward').toBe('build')
    expect(live.status).toBe('rework')
    expect(live.passes).toBe(2)
    expect(live.assigneeAgentId, 'the SAME builder, not a replacement').toBe(builderId)

    // The findings are on the ticket, ordered so `must` reads first.
    const findings = listFindings(id)
    expect(findings).toHaveLength(2)
    expect(renderFindings(findings).indexOf('[must]')).toBeLessThan(
      renderFindings(findings).indexOf('[nit]'),
    )
  })

  it('finishing the rework closes the fix list', async () => {
    const id = readyForReview('Fix the nav')
    const n = getTicket(id)!.number
    await advance(n, builderId, 'builder')
    await fail(n, [{ summary: 'Nav collapses too early.' }])

    expect(listFindings(id).filter((f) => !f.resolvedAt)).toHaveLength(1)
    await advance(n, builderId, 'builder')
    expect(
      listFindings(id).filter((f) => !f.resolvedAt),
      'a reviewer should not re-report what was already fixed',
    ).toHaveLength(0)
    expect(activeStep(acceptedRoute(id))!.kind).toBe('review')
  })

  it(`stops after ${MAX_REVIEW_PASSES} passes and puts it to the user`, async () => {
    const id = readyForReview('Argue about spacing')
    const n = getTicket(id)!.number

    for (let pass = 1; pass < MAX_REVIEW_PASSES; pass++) {
      await advance(n, builderId, 'builder')
      const res = await fail(n, [{ summary: `Still wrong, round ${pass}.` }])
      expect(res.structuredContent?.['escalated']).toBeUndefined()
    }

    await advance(n, builderId, 'builder')
    const last = await fail(n, [{ summary: 'And again.' }])
    expect(last.structuredContent?.['escalated'], 'the loop must not run forever').toBe(true)

    // It stayed on review rather than bouncing back a fourth time.
    expect(activeStep(acceptedRoute(id))!.kind).toBe('review')
  })

  it('resolveFindings only closes the pass it was told to', () => {
    const t = createTicket({ projectId, title: 'Passes', lane: 'in_progress' })
    addFindings({ ticketId: t.id, projectId, pass: 1, byAgentId: null, items: [{ summary: 'a' }] })
    addFindings({ ticketId: t.id, projectId, pass: 2, byAgentId: null, items: [{ summary: 'b' }] })
    expect(resolveFindings(t.id, 1)).toBe(1)
    expect(listFindings(t.id).filter((f) => !f.resolvedAt).map((f) => f.summary)).toEqual(['b'])
  })
})
