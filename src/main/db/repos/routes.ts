import type { RouteStatus, RouteStep, StepKind, TicketRoute } from '@shared/types'
import { activeStep } from '@shared/types'
import { all, bool, fromBool, get, id, json, now, parseJson, run, tx } from '../index'
import { updateTicket } from './tickets'

/**
 * Routes: how *this* ticket gets handled.
 *
 * At most one `accepted` route per ticket, and at most one `proposed` one. Superseded
 * routes are kept rather than deleted, so you can see what the Pilot suggested before you
 * changed it.
 *
 * `tickets.stage` is a mirror of the active step. Every write that can move the active step
 * goes through here so the mirror cannot drift — nothing else in the codebase writes it.
 */

type Row = Record<string, unknown>

function map(r: Row): TicketRoute {
  return {
    id: r['id'] as string,
    ticketId: r['ticket_id'] as string,
    projectId: r['project_id'] as string,
    status: r['status'] as RouteStatus,
    rationale: (r['rationale'] as string) ?? '',
    proposedByAgentId: (r['proposed_by_agent_id'] as string | null) ?? null,
    autoAccepted: fromBool(r['auto_accepted']),
    steps: parseJson<RouteStep[]>(r['steps_json'], []),
    createdAt: r['created_at'] as number,
    updatedAt: r['updated_at'] as number,
  }
}

export function listRoutes(projectId: string): TicketRoute[] {
  return all<Row>(
    `SELECT * FROM ticket_routes
     WHERE project_id = ? AND status IN ('proposed','accepted')
     ORDER BY created_at`,
    projectId,
  ).map(map)
}

export function getRoute(routeId: string): TicketRoute | null {
  const r = get<Row>('SELECT * FROM ticket_routes WHERE id = ?', routeId)
  return r ? map(r) : null
}

export function acceptedRoute(ticketId: string): TicketRoute | null {
  const r = get<Row>(
    "SELECT * FROM ticket_routes WHERE ticket_id = ? AND status = 'accepted'",
    ticketId,
  )
  return r ? map(r) : null
}

export function proposedRoute(ticketId: string): TicketRoute | null {
  const r = get<Row>(
    "SELECT * FROM ticket_routes WHERE ticket_id = ? AND status = 'proposed' ORDER BY created_at DESC LIMIT 1",
    ticketId,
  )
  return r ? map(r) : null
}

/** Tickets with no route at all — what the Pilot is asked to route. */
export function unroutedTickets(projectId: string): Array<{ id: string; number: number; title: string }> {
  return all<{ id: string; number: number; title: string }>(
    `SELECT t.id, t.number, t.title FROM tickets t
     WHERE t.project_id = ?
       AND t.archived_at IS NULL
       AND t.lane <> 'done'
       AND NOT EXISTS (
         SELECT 1 FROM ticket_routes r
         WHERE r.ticket_id = t.id AND r.status IN ('proposed','accepted'))
     ORDER BY t.backlog_rank IS NULL, t.backlog_rank, t.number`,
    projectId,
  )
}

/**
 * Accepted routes whose active step has nobody on it — "ready, waiting for a person".
 *
 * This is where work waits, and it is deliberately not a queue table. A queue would have to
 * stay in sync with route status, ticket lane, dependencies and roster changes: four ways to
 * drift. The route already knows, durably and per ticket, and it survives a restart for free.
 */
export function waitingTickets(
  projectId: string,
): Array<{ id: string; number: number; title: string; kind: StepKind }> {
  const rows = all<{ id: string; number: number; title: string; steps_json: string }>(
    `SELECT t.id, t.number, t.title, r.steps_json FROM tickets t
     JOIN ticket_routes r ON r.ticket_id = t.id AND r.status = 'accepted'
     WHERE t.project_id = ?
       AND t.archived_at IS NULL
       AND t.lane <> 'done'
     ORDER BY t.backlog_rank IS NULL, t.backlog_rank, t.number`,
    projectId,
  )
  const out: Array<{ id: string; number: number; title: string; kind: StepKind }> = []
  for (const r of rows) {
    const steps = JSON.parse(r.steps_json) as RouteStep[]
    const step = activeStep({ steps } as TicketRoute)
    if (step && !step.assigneeAgentId) {
      out.push({ id: r.id, number: r.number, title: r.title, kind: step.kind })
    }
  }
  return out
}

export interface StepSpec {
  kind: StepKind
  assigneeAgentId?: string | null
  note?: string | null
  brief?: string | null
}

function materialise(specs: StepSpec[]): RouteStep[] {
  return specs.map((s, i) => ({
    id: `s${i + 1}`,
    kind: s.kind,
    assigneeAgentId: s.assigneeAgentId ?? null,
    status: 'pending' as const,
    passes: 1,
    note: s.note ?? null,
    brief: s.brief ?? null,
  }))
}

export function proposeRoute(input: {
  ticketId: string
  projectId: string
  steps: StepSpec[]
  rationale: string
  proposedByAgentId: string | null
}): TicketRoute {
  return tx(() => {
    // Only one open proposal per ticket — a second one replaces the first rather than
    // stacking two cards the user has to reconcile.
    run(
      `UPDATE ticket_routes SET status = 'superseded', resolved_at = ?
       WHERE ticket_id = ? AND status = 'proposed'`,
      now(),
      input.ticketId,
    )
    const rid = id()
    const t = now()
    run(
      `INSERT INTO ticket_routes
         (id, ticket_id, project_id, status, rationale, proposed_by_agent_id, steps_json,
          created_at, updated_at)
       VALUES (?,?,?,'proposed',?,?,?,?,?)`,
      rid,
      input.ticketId,
      input.projectId,
      input.rationale,
      input.proposedByAgentId,
      json(materialise(input.steps)),
      t,
      t,
    )
    return getRoute(rid)!
  })
}

/**
 * Accept a route and make its first step active.
 *
 * `steps` overrides what was proposed — that is how "accept, but drop the review step"
 * works from the UI without a separate edit round-trip.
 */
export function acceptRoute(routeId: string, steps?: StepSpec[], auto = false): TicketRoute | null {
  return tx(() => {
    const r = getRoute(routeId)
    if (!r || (r.status !== 'proposed' && r.status !== 'accepted')) return null

    run(
      `UPDATE ticket_routes SET status = 'superseded', resolved_at = ?
       WHERE ticket_id = ? AND status = 'accepted' AND id <> ?`,
      now(),
      r.ticketId,
      routeId,
    )

    const next = steps ? materialise(steps) : r.steps.map((s) => ({ ...s }))
    if (next.length === 0) return null
    // First step goes live immediately; accepting a route IS starting the work.
    if (!next.some((s) => s.status === 'active' || s.status === 'rework')) {
      const first = next.find((s) => s.status !== 'done') ?? next[0]!
      first.status = 'active'
    }

    run(
      `UPDATE ticket_routes
         SET status = 'accepted', steps_json = ?, auto_accepted = ?, updated_at = ?, resolved_at = ?
       WHERE id = ?`,
      json(next),
      bool(auto),
      now(),
      now(),
      routeId,
    )
    mirror(r.ticketId, next)
    return getRoute(routeId)
  })
}

export function rejectRoute(routeId: string): void {
  run(
    "UPDATE ticket_routes SET status = 'rejected', resolved_at = ?, updated_at = ? WHERE id = ?",
    now(),
    now(),
    routeId,
  )
}

/** Replace the steps of a live route wholesale — used by the route editor. */
export function setSteps(routeId: string, steps: RouteStep[]): TicketRoute | null {
  return tx(() => {
    const r = getRoute(routeId)
    if (!r) return null
    run(
      'UPDATE ticket_routes SET steps_json = ?, updated_at = ? WHERE id = ?',
      json(steps),
      now(),
      routeId,
    )
    if (r.status === 'accepted') mirror(r.ticketId, steps)
    return getRoute(routeId)
  })
}

export function assignStep(ticketId: string, stepId: string, agentId: string | null): TicketRoute | null {
  const r = acceptedRoute(ticketId)
  if (!r) return null
  return setSteps(
    r.id,
    r.steps.map((s) => (s.id === stepId ? { ...s, assigneeAgentId: agentId } : s)),
  )
}

export interface AdvanceResult {
  route: TicketRoute
  finished: RouteStep
  next: RouteStep | null
  /** True when that was the last step — the ticket's route is complete. */
  routeComplete: boolean
}

/**
 * Mark the active step done and start the next one.
 *
 * A step that is in `rework` completes back to `done` — the pass counter, not the status,
 * is what records that it went round twice.
 */
export function completeActiveStep(ticketId: string): AdvanceResult | null {
  return tx(() => {
    const r = acceptedRoute(ticketId)
    if (!r) return null
    const cur = activeStep(r)
    if (!cur) return null

    const steps = r.steps.map((s) => (s.id === cur.id ? { ...s, status: 'done' as const } : s))
    const idx = steps.findIndex((s) => s.id === cur.id)
    const next = steps.slice(idx + 1).find((s) => s.status === 'pending') ?? null
    if (next) next.status = 'active'

    run(
      'UPDATE ticket_routes SET steps_json = ?, updated_at = ? WHERE id = ?',
      json(steps),
      now(),
      r.id,
    )
    mirror(ticketId, steps)
    return {
      route: getRoute(r.id)!,
      finished: steps[idx]!,
      next,
      routeComplete: next === null,
    }
  })
}

/**
 * Send a route back to an earlier step. This is what a failed review does: it does NOT
 * create a new ticket, because the builder still has the whole problem in its head.
 */
export function reworkTo(ticketId: string, kind: StepKind): TicketRoute | null {
  return tx(() => {
    const r = acceptedRoute(ticketId)
    if (!r) return null
    const target = [...r.steps].reverse().find((s) => s.kind === kind)
    if (!target) return null

    const ti = r.steps.findIndex((s) => s.id === target.id)
    const steps = r.steps.map((s, i) => {
      if (i === ti) return { ...s, status: 'rework' as const, passes: s.passes + 1 }
      // Everything after the reworked step goes back to pending — a review that already
      // passed must run again against the new code.
      if (i > ti) return { ...s, status: 'pending' as const }
      return s
    })

    run(
      'UPDATE ticket_routes SET steps_json = ?, updated_at = ? WHERE id = ?',
      json(steps),
      now(),
      r.id,
    )
    mirror(ticketId, steps)
    return getRoute(r.id)
  })
}

/** The single place `tickets.stage` is written. Keeps the mirror from drifting. */
function mirror(ticketId: string, steps: RouteStep[]): void {
  const live = steps.find((s) => s.status === 'active' || s.status === 'rework') ?? null
  updateTicket(ticketId, { stage: live ? live.kind : null })
}

/** Highest pass count on the route — what the `pass N` badge shows. */
export function maxPasses(route: TicketRoute | null): number {
  if (!route) return 1
  return route.steps.reduce((m, s) => Math.max(m, s.passes), 1)
}

export function setBacklogOrder(projectId: string, ticketNumbers: number[]): void {
  tx(() => {
    ticketNumbers.forEach((n, i) => {
      run(
        'UPDATE tickets SET backlog_rank = ?, updated_at = ? WHERE project_id = ? AND number = ?',
        i + 1,
        now(),
        projectId,
        n,
      )
    })
  })
}
