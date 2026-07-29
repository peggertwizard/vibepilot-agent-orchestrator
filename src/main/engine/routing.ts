import type { TicketRoute } from '@shared/types'
import { STEP_LABEL, routeSummary } from '@shared/types'
import { bus } from '../bus'
import { getAgent, setAgentStatus } from '../db/repos/agents'
import { addMessage } from '../db/repos/messages'
import { acceptRoute, acceptedRoute, assignStep, unroutedTickets } from '../db/repos/routes'
import { getTicket } from '../db/repos/tickets'
import { flushWrites } from '../db/writer'
import { manager } from './manager'
import { pilot } from './pilot'
import { launchTeammate } from './teammate'

/**
 * The routing loop: a ticket appears, the Pilot proposes how to handle it, the user accepts.
 *
 * The nudge is coalesced deliberately. Accepting ten drafts in a row would otherwise cost
 * ten Pilot turns, each with a cold cache read — one turn that sees all ten is both cheaper
 * and better, because the Pilot can order them against each other.
 */

const NUDGE_MS = 1500

class RoutingService {
  private timers = new Map<string, NodeJS.Timeout>()

  /** Ask the Pilot to route anything that has no route. Safe to call as often as you like. */
  nudge(projectId: string): void {
    const existing = this.timers.get(projectId)
    if (existing) clearTimeout(existing)
    this.timers.set(
      projectId,
      setTimeout(() => {
        this.timers.delete(projectId)
        this.fire(projectId)
      }, NUDGE_MS),
    )
  }

  private fire(projectId: string): void {
    const pending = unroutedTickets(projectId)
    if (pending.length === 0) return

    const list = pending.map((t) => `- #${t.number} ${t.title}`).join('\n')
    pilot.notify(
      projectId,
      `${pending.length === 1 ? 'A ticket has' : `${pending.length} tickets have`} no route yet:\n` +
        `${list}\n\n` +
        `Call \`propose_route\` for each. Read the ticket — and the code, if that is what it ` +
        `takes — and pick the shape that actually fits it. A question wants \`research\` and ` +
        `no builder; something risky or visual earns a reviewer; a small fix wants one ` +
        `\`build\` and nothing else. Deciding well is the job; there is no house default to ` +
        `fall back on. ` +
        (pending.length > 1
          ? `Then call \`set_backlog_order\` with the order you think they should be done in. `
          : '') +
        `Do not start work on backlog items the user has not asked for.`,
    )
  }

  /**
   * Accept a route and start it.
   *
   * This is now reached ONLY by the user pressing Start. It used to be reachable by the Pilot
   * setting `confident: true`, which is how ticket #1 came to have `auto_accepted: 1` and a
   * teammate running before anything appeared on screen.
   *
   * The distinction that matters is conversation versus commitment. Deciding well and acting
   * unannounced are different things, and only the first was ever asked for.
   */
  apply(route: TicketRoute): TicketRoute | null {
    const applied = acceptRoute(route.id, undefined, false)
    if (!applied) return null

    const ticket = getTicket(applied.ticketId)
    if (!ticket) return applied
    const summary = routeSummary(applied.steps)

    addMessage({
      projectId: applied.projectId,
      agentId: applied.proposedByAgentId,
      authorType: 'system',
      kind: 'notice',
      body: `#${ticket.number} started: ${summary}.`,
    })
    flushWrites()
    bus.emitDomain({ type: 'routes:changed', projectId: applied.projectId })
    bus.emitDomain({ type: 'tickets:changed', projectId: applied.projectId })
    bus.emitDomain({ type: 'messages:changed', projectId: applied.projectId })

    // Start the person the card said would do it, without spending a Pilot turn to say
    // "now go". The user already approved this exact assignment; asking the Pilot to
    // re-issue it is a round-trip that can only introduce drift.
    const started = startActiveStep(applied)

    pilot.notify(
      applied.projectId,
      `The user pressed Start on #${ticket.number}: ${summary}. ` +
        (started
          ? `${started} is on it — you do not need to assign anyone. Let them work.`
          : describeNext(applied)),
    )

    // Waiting is not the only thing available. If other tickets have no route, this is the
    // moment to deal with them.
    if (started) this.fillTheGap(applied.projectId)
    return applied
  }

  /**
   * A teammate just started, so the Pilot has a gap. Give it the work already sitting there.
   *
   * *"There will be other things that will come up, it can't JUST wait."* Right — and today it
   * genuinely could only wait, because delegating left it with no queue of its own. This does
   * not invent work: it fires the ordinary routing nudge, which is a no-op unless there are
   * tickets with no route. Coalesced like every other nudge, so ten teammates starting at once
   * is one turn.
   */
  fillTheGap(projectId: string): void {
    if (unroutedTickets(projectId).length === 0) return
    this.nudge(projectId)
  }

  /**
   * Tell the Pilot a step finished and what is next. This is the only way it learns that a
   * route moved — it never watches the board.
   */
  announceStep(projectId: string, ticketNumber: number, ticketId: string): void {
    const route = acceptedRoute(ticketId)
    if (!route) return
    pilot.notify(projectId, `#${ticketNumber} moved on. ${describeNext(route)}`)
  }
}

/**
 * Launch whoever the accepted route says holds the live step.
 *
 * Returns their name if a process was started, null if the step has nobody on it — which is a
 * legitimate state ("ready, waiting for a person") rather than an error.
 */
function startActiveStep(route: TicketRoute): string | null {
  const live = route.steps.find((s) => s.status === 'active' || s.status === 'rework')
  if (!live?.assigneeAgentId) return null
  const who = getAgent(live.assigneeAgentId)
  const ticket = getTicket(route.ticketId)
  if (!who || !ticket) return null

  // Already running — accepting a route must never give one person a second process.
  if (manager.forAgent(who.id)) return who.name

  assignStep(route.ticketId, live.id, who.id)
  setAgentStatus(who.id, 'queued', `Starting #${ticket.number}`)
  flushWrites()
  bus.emitDomain({ type: 'agents:changed', projectId: route.projectId })

  void launchTeammate({
    projectId: route.projectId,
    agentId: who.id,
    name: who.name,
    role: who.role,
    provider: who.provider,
    model: who.model,
    ticketId: route.ticketId,
    brief: live.brief ?? `${ticket.title}\n\n${ticket.body}`.trim(),
    pilotAgentId: route.proposedByAgentId ?? '',
  }).catch((e: Error) => {
    setAgentStatus(who.id, 'error', e.message.slice(0, 120))
    bus.emitDomain({ type: 'agents:changed', projectId: route.projectId })
  })

  return who.name
}

function describeNext(route: TicketRoute): string {
  const live = route.steps.find((s) => s.status === 'active' || s.status === 'rework')
  if (!live) return 'Every step on its route is done — check it and put it in front of the user.'
  const who = live.assigneeAgentId ? getAgent(live.assigneeAgentId) : null
  const step = `${STEP_LABEL[live.kind]}${live.status === 'rework' ? ` (pass ${live.passes})` : ''}`
  return who
    ? `Current step: ${step}, assigned to ${who.name}.`
    : `Current step: ${step}, unassigned — spawn or assign someone.`
}

export const routing = new RoutingService()
