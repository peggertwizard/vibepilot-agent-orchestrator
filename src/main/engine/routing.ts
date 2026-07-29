import type { TicketRoute } from '@shared/types'
import { STEP_LABEL, routeSummary } from '@shared/types'
import { bus } from '../bus'
import { getAgent, setAgentStatus } from '../db/repos/agents'
import { unmetDependencies } from '../db/repos/epics'
import { addMessage } from '../db/repos/messages'
import {
  acceptRoute,
  acceptedRoute,
  assignStep,
  proposedRoute,
  safePrefixLength,
  unroutedTickets,
} from '../db/repos/routes'
import { getTicket, getTicketByNumber } from '../db/repos/tickets'
import { getProject, spendBlocked } from '../db/repos/projects'
import { notifyUser } from '../notify'
import { flushWrites } from '../db/writer'
import { pilot } from './pilot'
import { launchTeammate } from './teammate'
import * as gate from './gate'

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
        `no builder; a small fix wants one \`build\` and nothing else. Whether a reviewer is ` +
        `added is NOT your judgement — the rule is in your instructions and the user sets it. ` +
        `Deciding the rest well is the job; there is no house default to fall back on. ` +
        (pending.length > 1
          ? `Then call \`set_backlog_order\` with the order you think they should be done in. `
          : '') +
        `Do not start work on backlog items the user has not asked for.`,
    )
  }

  /**
   * Accept a route and start it.
   *
   * Two callers: the Start button, and `maybeAutoStart` when the project is set to run things
   * itself. It used to be reachable by the Pilot setting `confident: true`, which is how
   * ticket #1 came to have `auto_accepted: 1` and a teammate running before anything appeared
   * on screen — and the lesson taken from that was the wrong one for a while. The problem was
   * never that it acted; it was that it acted silently. `opts.auto` therefore changes what is
   * *said*, and nothing about what is checked.
   */
  apply(route: TicketRoute, opts: { auto?: boolean } = {}): TicketRoute | null {
    const ticket0 = getTicket(route.ticketId)
    if (!ticket0) return null

    /*
     * Dependencies, on the path people actually take.
     *
     * `unmetDependencies` was enforced in `assign_work` and unit-tested, and this path — the
     * Start button — called `startActiveStep` directly and never consulted it. So a route
     * whose card already named an assignee launched regardless of what it was waiting on,
     * which is every route the Pilot proposes. The tested guard was on the road nobody used.
     *
     * It refuses rather than queues: "#4 must land first" is a fact about the work, not a
     * scheduling wait, and it usually means the ticket should not exist yet in this form.
     */
    const unmet = unmetDependencies(ticket0.projectId, ticket0.id)
    if (unmet.length > 0) {
      addMessage({
        projectId: ticket0.projectId,
        agentId: null,
        authorType: 'system',
        kind: 'notice',
        body:
          `#${ticket0.number} did not start: it depends on ` +
          `${unmet.map((n) => `#${n}`).join(', ')}, which ${unmet.length === 1 ? 'has' : 'have'} ` +
          `not landed yet. Merge ${unmet.length === 1 ? 'it' : 'those'} first, or remove the ` +
          `dependency on the ticket.`,
      })
      flushWrites()
      bus.emitDomain({ type: 'messages:changed', projectId: ticket0.projectId })
      return null
    }

    const applied = acceptRoute(route.id, undefined, opts.auto ?? false)
    if (!applied) return null

    const ticket = getTicket(applied.ticketId)
    if (!ticket) return applied
    const summary = routeSummary(applied.steps)

    addMessage({
      projectId: applied.projectId,
      agentId: applied.proposedByAgentId,
      authorType: 'system',
      kind: 'notice',
      body: opts.auto
        ? `#${ticket.number} started on its own: ${summary}. Nothing has been merged or ` +
          `deployed — stop or change it from the card.`
        : `#${ticket.number} started: ${summary}.`,
    })
    flushWrites()
    bus.emitDomain({ type: 'routes:changed', projectId: applied.projectId })
    bus.emitDomain({ type: 'tickets:changed', projectId: applied.projectId })
    bus.emitDomain({ type: 'messages:changed', projectId: applied.projectId })

    // Start the person the card said would do it, without spending a Pilot turn to say
    // "now go". The user already approved this exact assignment; asking the Pilot to
    // re-issue it is a round-trip that can only introduce drift.
    const started = startActiveStep(applied)

    /*
     * The card, at the moment the work begins rather than after it.
     *
     * With no button to press, this notification is the only thing standing between "work
     * starts on its own" and "work starts invisibly", which is the failure this whole design
     * is arranged around.
     */
    if (opts.auto) {
      notifyUser({
        projectId: applied.projectId,
        title: `#${ticket.number} started`,
        body: `${ticket.title} — ${summary}. You can stop or change it.`,
      })
    }

    pilot.notify(
      applied.projectId,
      (opts.auto
        ? `#${ticket.number} started automatically: ${summary}. `
        : `The user pressed Start on #${ticket.number}: ${summary}. `) +
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
   * Start this route without being asked, if the project says so.
   *
   * **Work starts on its own. It never starts invisibly.** That sentence is the whole design,
   * and it is the distinction the first version of auto-start missed: the original complaint
   * was never "it started work", it was *"a teammate was running before anything appeared on
   * screen"*. Surprise, not speed.
   *
   * So this deliberately goes through `apply`, which writes the notice, emits the board change
   * and notifies — in that order, before the process spawns. If the card ever lags the spawn,
   * this is exactly the behaviour that was removed.
   *
   * Returns whether it started, so the caller can say the right thing.
   */
  maybeAutoStart(route: TicketRoute, confident: boolean): boolean {
    const project = getProject(route.projectId)
    if (!project || project.autoStart === 'never') return false

    // The Pilot itself said it was unsure. Autonomy is not the absence of judgement.
    if (!confident) return false

    /*
     * A gate is not a reason to refuse — it is a reason to stop *later*.
     *
     * The steps before it are research and planning: they read, think, and write a document,
     * and none of that reaches the base branch. Refusing to start them would mean the user is
     * asked to approve a build with nothing to read, which is the worst possible moment.
     * `completeActiveStep` parks the route when it reaches the gated step.
     */
    const safeSteps = safePrefixLength(route)
    const hasGate = safeSteps < route.steps.length

    if (project.autoStart === 'simple') {
      /*
       * One step, one named person, no reviewer. Anything longer is either expensive or is
       * work the user would want to look at first — and a route with nobody on it cannot
       * start regardless, since there is no one to launch.
       *
       * A gated route counts as its safe prefix: "plan, then sign-off, then build" is one
       * cheap step and a stop, which is exactly the shape this setting is happy with.
       */
      const considered = hasGate ? route.steps.slice(0, safeSteps) : route.steps
      const onlyStep = considered.length === 1 ? considered[0] : null
      if (!onlyStep || !onlyStep.assigneeAgentId || onlyStep.kind === 'review') return false
    }

    /*
     * The always-stops. Each is either irreversible or expensive, and none of them is
     * reached from here: merging and deploying are separate user actions, dependencies are
     * refused inside `apply`, and the spend ceiling parks the launch inside the gate. This
     * is the list, written down, so the next person to touch it knows what it is protecting.
     */
    const blocked = spendBlocked(route.projectId)
    if (blocked) {
      addMessage({
        projectId: route.projectId,
        agentId: null,
        authorType: 'system',
        kind: 'notice',
        body: `Did not start automatically. ${blocked}`,
      })
      flushWrites()
      bus.emitDomain({ type: 'messages:changed', projectId: route.projectId })
      return false
    }

    return this.apply(route, { auto: true }) !== null
  }

  /**
   * Launch the step a sign-off just released.
   *
   * `approveGate` has already made it active; this is the part that puts somebody on it. The
   * same `startActiveStep` every other path uses, so the queue, the concurrency cap and the
   * pause toggle all apply exactly as they would have if it had never been gated.
   */
  startApproved(ticketId: string): string | null {
    const route = acceptedRoute(ticketId)
    if (!route) return null
    return startActiveStep(route)
  }

  /**
   * Start tickets a merge has just unblocked.
   *
   * Only under `autoStart` — a project set to "ask me first" should not suddenly begin work
   * because something else landed. Under the others this is what makes a dependency chain
   * actually flow: #6 merges, #8 begins, nobody pressed anything.
   */
  startUnblocked(projectId: string, ticketNumbers: number[]): void {
    const project = getProject(projectId)
    if (!project || project.autoStart === 'never') return

    for (const n of ticketNumbers) {
      const ticket = getTicketByNumber(projectId, n)
      if (!ticket) continue
      // An accepted route means it is already on its way; a proposed one is what we can start.
      const route = proposedRoute(ticket.id)
      if (route) this.maybeAutoStart(route, true)
    }
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

  /*
   * Busy is a reason to WAIT, not a reason to forget.
   *
   * This used to `return` here, which silently dropped the launch: two tickets routed to the
   * same reviewer meant the second one sat at `active` for ever beside an idle agent, with
   * nothing queued and nothing to retry it. Accepting a route still must never give one person
   * two processes — that part was right — but the queue is what enforces it now, and the gate
   * starts the work the moment they are free.
   */

  assignStep(route.ticketId, live.id, who.id)
  setAgentStatus(who.id, 'queued', `Starting #${ticket.number}`)
  flushWrites()
  bus.emitDomain({ type: 'agents:changed', projectId: route.projectId })

  /*
   * Through the gate, not straight at the process. The concurrency cap and the pause both
   * live there; calling launchTeammate directly is what made the cap decorative.
   */
  gate.submit({
    projectId: route.projectId,
    agentId: who.id,
    run: () =>
      launchTeammate({
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
      }),
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
