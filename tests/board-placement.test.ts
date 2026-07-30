import { describe, expect, it } from 'vitest'
import { derivePlacement } from '../src/shared/board'
import type { BoardFacts } from '../src/shared/board'
import { LANES } from '../src/shared/types'
import type { RouteStep, StepKind, TicketRoute } from '../src/shared/types'

/**
 * The board cannot lie.
 *
 * The card that caused this file said three things at once — column "In progress", badge
 * "ready", assignee "Finished" — and only the third was true. These tests are less about the
 * specific bug than about the shape of it: a lane with six writers and no reconciler drifts by
 * construction, so what is asserted here is that placement is *total* and *unique* over every
 * combination of inputs, not that a handful of known cases come out right.
 */

function step(kind: StepKind, over: Partial<RouteStep> = {}): RouteStep {
  return {
    id: 's1',
    kind,
    assigneeAgentId: null,
    status: 'pending',
    passes: 1,
    note: null,
    brief: null,
    ...over,
  } as RouteStep
}

function route(steps: RouteStep[]): TicketRoute {
  return {
    id: 'r1',
    ticketId: 't1',
    projectId: 'p1',
    status: 'accepted',
    rationale: '',
    proposedByAgentId: null,
    autoAccepted: false,
    steps,
    createdAt: 0,
    updatedAt: 0,
  }
}

const base: BoardFacts = {
  merged: false,
  readyToMerge: false,
  route: null,
  assigneeLive: false,
  assigneeQueued: false,
}

describe('the placement is total and unique', () => {
  /**
   * Every reachable combination. If a future lane or step status has no home, this fails
   * before anyone sees a card in the wrong column.
   */
  const routes: Array<TicketRoute | null> = [
    null,
    route([]),
    route([step('build')]),
    route([step('build', { status: 'active' })]),
    route([step('build', { status: 'active', assigneeAgentId: 'a1' })]),
    route([step('build', { status: 'rework', assigneeAgentId: 'a1', passes: 2 })]),
    route([step('build', { status: 'done' })]),
    route([step('build', { status: 'done' }), step('review', { status: 'active' })]),
    route([
      step('build', { status: 'done' }),
      step('review', { status: 'active', assigneeAgentId: 'a2' }),
    ]),
    route([step('build', { status: 'done' }), step('review', { status: 'done' })]),
    // Gated: the safe prefix ran, the gated step is pending, nothing is active. A state the
    // board must place, or plan 30's bug comes back wearing a new hat.
    route([step('plan', { status: 'done' }), step('build', { gate: true })]),
    route([step('plan', { status: 'done' }), step('build', { gate: true }), step('review')]),
  ]

  it('places every combination in exactly one known lane', () => {
    for (const r of routes) {
      for (const merged of [false, true]) {
        for (const readyToMerge of [false, true]) {
          for (const assigneeLive of [false, true]) {
            for (const assigneeQueued of [false, true]) {
              const p = derivePlacement({
                ...base,
                route: r,
                merged,
                readyToMerge,
                assigneeLive,
                assigneeQueued,
              })
              expect(LANES).toContain(p.lane)
              expect(LANES.filter((l) => l === p.lane)).toHaveLength(1)
              // A placement with no explanation is a placement nobody can argue with.
              expect(p.because.length).toBeGreaterThan(0)
              expect(p.because.endsWith('.')).toBe(true)
            }
          }
        }
      }
    }
  })

  it('never reports stuck for a lane other than In progress', () => {
    for (const r of routes) {
      for (const assigneeLive of [false, true]) {
        for (const assigneeQueued of [false, true]) {
          const p = derivePlacement({ ...base, route: r, assigneeLive, assigneeQueued })
          if (p.stuck) expect(p.lane).toBe('in_progress')
        }
      }
    }
  })
})

describe('the card that prompted this', () => {
  /** #5: READY badge, IN PROGRESS column, assignee Finished. */
  it('a ready ticket leaves In progress even with an active-looking route', () => {
    const p = derivePlacement({
      ...base,
      readyToMerge: true,
      route: route([step('build', { status: 'active', assigneeAgentId: 'a1' })]),
    })
    expect(p.lane).toBe('waiting')
    expect(p.stuck).toBe(false)
  })

  it('merged outranks ready', () => {
    const p = derivePlacement({ ...base, merged: true, readyToMerge: true })
    expect(p.lane).toBe('done')
  })
})

describe('a stall is visible without cross-checking anything', () => {
  it('assigned, not live, not queued is stuck', () => {
    const p = derivePlacement({
      ...base,
      route: route([step('build', { status: 'active', assigneeAgentId: 'a1' })]),
    })
    expect(p.lane).toBe('in_progress')
    expect(p.stuck).toBe(true)
  })

  /** The reviewer case: build done, review active, nobody assigned, nothing running. */
  it('an unassigned step after finished work is stuck, not waiting to be picked up', () => {
    const p = derivePlacement({
      ...base,
      route: route([step('build', { status: 'done' }), step('review', { status: 'active' })]),
    })
    expect(p.lane).toBe('in_progress')
    expect(p.stuck).toBe(true)
  })

  it('queued is not stuck — that wait ends on its own', () => {
    const p = derivePlacement({
      ...base,
      assigneeQueued: true,
      route: route([step('build', { status: 'active', assigneeAgentId: 'a1' })]),
    })
    expect(p.lane).toBe('todo')
    expect(p.stuck).toBe(false)
  })

  it('live work is in progress and never stuck', () => {
    const p = derivePlacement({
      ...base,
      assigneeLive: true,
      route: route([step('build', { status: 'active', assigneeAgentId: 'a1' })]),
    })
    expect(p.lane).toBe('in_progress')
    expect(p.stuck).toBe(false)
  })
})

describe('a route waiting for your sign-off', () => {
  /**
   * *"if a ticket is sitting in the backlog but has a plan to it, could it really not start
   * already?"* — the plan can start, the build cannot. This is what that looks like once the
   * plan has run.
   */
  it('is waiting for you, not stuck and not in progress', () => {
    const p = derivePlacement({
      ...base,
      route: route([step('plan', { status: 'done' }), step('build', { gate: true })]),
    })
    expect(p.lane).toBe('waiting')
    expect(p.stuck).toBe(false)
    expect(p.because).toContain('sign-off')
  })

  it('is not confused with a finished route', () => {
    const finished = derivePlacement({
      ...base,
      route: route([step('plan', { status: 'done' }), step('build', { status: 'done' })]),
    })
    expect(finished.because).not.toContain('sign-off')
  })
})

describe('the quiet cases', () => {
  it('no route is backlog', () => {
    expect(derivePlacement(base).lane).toBe('backlog')
  })

  it('a routed but unstarted ticket is To do', () => {
    expect(derivePlacement({ ...base, route: route([step('build')]) }).lane).toBe('todo')
  })

  it('every step done but not marked ready is still waiting on the user', () => {
    const p = derivePlacement({ ...base, route: route([step('build', { status: 'done' })]) })
    expect(p.lane).toBe('waiting')
  })
})
