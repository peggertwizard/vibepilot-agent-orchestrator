import type { Ticket } from '@shared/types'
import { activeStep } from '@shared/types'
import { bus } from '../bus'
import { getAgent, setAgentStatus } from '../db/repos/agents'
import { addMessage } from '../db/repos/messages'
import { getProject } from '../db/repos/projects'
import { acceptedRoute } from '../db/repos/routes'
import { getTicket, listTickets } from '../db/repos/tickets'
import { flushWrites } from '../db/writer'
import { notifyUser } from '../notify'
import * as gate from './gate'
import { manager } from './manager'
import { pilot } from './pilot'
import { launchTeammate } from './teammate'

/**
 * Putting work back on its feet.
 *
 * A route step says `active`, a teammate is assigned to it, and **nothing is running**. The
 * board shows the ticket sitting there; the message log's last line is an error from twenty
 * minutes ago; the Pilot says "restarted it" and it stalls again. Watching that happen is what
 * this file is for: *"if this is detected it needs to fire a fix of some sort."*
 *
 * Two causes were confirmed in real use, and they want the same remedy:
 *
 *   1. **The launch itself failed.** Before 0.3.1, `launchTeammate` read `mcpServer.url`
 *      without ever starting the server, so every path except "the Pilot went first" threw.
 *      The step stayed `active` for ever because nothing walks routes looking for orphans.
 *   2. **The model call failed.** Rate limits on the big model, mid-run. Transient, clears on
 *      its own, and the only correct response is to try again a few minutes later.
 *
 * The remedy is a **resume**, not a fresh start: the session id and the worktree have been
 * persisted since the process layer was built precisely so a restart carries on rather than
 * re-reading the codebase and redoing committed work.
 *
 * What this file deliberately does not do: retry for ever. One automatic attempt per teammate
 * per app run, then it becomes something the user is told about. A loop that keeps relaunching
 * a genuinely broken step burns the rate limit it is usually waiting on.
 */

/** How long a step may sit `active` with nothing behind it before it counts as stuck. */
export const STUCK_GRACE_MS = 5 * 60_000

export interface StuckStep {
  ticket: Ticket
  agentId: string
  agentName: string
  /** The brief the step was launched with, so a resume lands in the same job. */
  brief: string | null
  /** What the agent's status line said. Used only for the message. */
  said: string | null
}

/**
 * Steps that claim to be running and are not.
 *
 * Deliberately **not** a status allowlist. The obvious version checks for `error` or
 * `stalled`, and misses the case that produced this file: a step activated by `advance_step`
 * whose launch never happened at all, whose agent still reads `idle` or `done` from the step it
 * finished ten minutes ago. Absence of a process is the fact; the status is commentary on it.
 *
 * The grace period is what keeps a launch that is merely *slow* out of this list — a spawn
 * takes seconds, and `queued` is checked separately because the gate holding work back is the
 * cap doing its job, not a fault.
 */
export function detectStuckSteps(projectId: string, now = Date.now()): StuckStep[] {
  const out: StuckStep[] = []

  for (const ticket of listTickets(projectId)) {
    if (ticket.lane === 'done' || ticket.readyToMerge) continue
    const step = activeStep(acceptedRoute(ticket.id))
    if (!step?.assigneeAgentId) continue

    const who = getAgent(step.assigneeAgentId)
    if (!who) continue

    // Running, or about to be. Neither is stuck.
    if (manager.forAgent(who.id)) continue
    if (gate.isQueued(who.id)) continue

    // Give a launch time to actually happen before calling it a failure.
    if (now - who.updatedAt < STUCK_GRACE_MS) continue

    out.push({
      ticket,
      agentId: who.id,
      agentName: who.name,
      brief: step.brief,
      said: who.statusLine,
    })
  }

  return out
}

/**
 * Start a teammate again on a ticket, resuming its session.
 *
 * Shared by the heartbeat, the Pilot's `restart_step` tool and the restart button, so the
 * three cannot drift apart. The ticket is a **parameter** rather than something this looks up:
 * the heartbeat already knows exactly which ticket the orphaned step belongs to, and searching
 * for "a ticket this agent is assigned to" can find a stale one from a previous job.
 */
export function relaunchAssignee(input: {
  agentId: string
  ticketId: string
  brief?: string | null
  /** What to show on the agent card while it waits for a slot. */
  because: string
  pilotAgentId?: string
}): boolean {
  const who = getAgent(input.agentId)
  const ticket = getTicket(input.ticketId)
  if (!who || !ticket) return false

  setAgentStatus(who.id, 'queued', input.because)
  flushWrites()
  bus.emitDomain({ type: 'agents:changed', projectId: who.projectId })

  gate.submit({
    projectId: who.projectId,
    agentId: who.id,
    run: () =>
      launchTeammate({
        projectId: who.projectId,
        agentId: who.id,
        name: who.name,
        role: who.role,
        provider: who.provider,
        model: who.model,
        ticketId: ticket.id,
        brief:
          input.brief ??
          `Carry on with #${ticket.number}: ${ticket.title}. Check what you have already ` +
            `done before redoing any of it.`,
        pilotAgentId: input.pilotAgentId ?? '',
        /*
         * The whole point. A cold start re-reads the codebase and repeats work already
         * sitting committed in the worktree.
         */
        resumeSessionId: who.sessionId,
      }).catch((e: Error) => {
        /*
         * Without this the rejection is unhandled — `gate.begin` does `void run()` — and the
         * agent freezes at `queued` for ever, which is worse than the failure it is hiding:
         * `queued` reads as "waiting for a slot" everywhere, including to this file's own
         * detector, so nothing ever looks at it again.
         */
        setAgentStatus(who.id, 'error', e.message.slice(0, 120))
        bus.emitDomain({ type: 'agents:changed', projectId: who.projectId })
      }),
  })

  return true
}

/**
 * One automatic attempt per teammate per app run.
 *
 * Cleared when that teammate completes a run (`startHeartbeat` subscribes), so an agent that
 * worked for two hours and then stalled earns a fresh attempt, while heal → immediate crash
 * escalates instead of looping.
 */
const attempts = new Map<string, number>()

export function clearHealAttempts(agentId: string): void {
  attempts.delete(agentId)
}

/** Test seam — the module keeps state for the life of the process. */
export function resetHealState(): void {
  attempts.clear()
  escalated.clear()
}

const escalated = new Set<string>()

/**
 * Find stuck steps and do something about them.
 *
 * Returns the tickets it acted on, so the caller can say so. `autoStart: 'never'` means the
 * user asked to press the button themselves — relaunching for them would be exactly the
 * surprise that setting exists to prevent, so those projects only ever get the report, which
 * surfaces in the Needs-you popover.
 */
export function healStuckSteps(
  projectId: string,
  relaunch: typeof relaunchAssignee = relaunchAssignee,
  now = Date.now(),
): number[] {
  const project = getProject(projectId)
  if (!project) return []

  const healed: number[] = []

  for (const stuck of detectStuckSteps(projectId, now)) {
    const tries = attempts.get(stuck.agentId) ?? 0

    if (tries >= 1 || project.autoStart === 'never') {
      escalate(projectId, stuck, project.autoStart === 'never')
      continue
    }

    attempts.set(stuck.agentId, tries + 1)
    if (!relaunch({
      agentId: stuck.agentId,
      ticketId: stuck.ticket.id,
      brief: stuck.brief,
      because: `Restarting #${stuck.ticket.number}`,
    })) {
      continue
    }

    addMessage({
      projectId,
      agentId: null,
      authorType: 'system',
      kind: 'notice',
      body:
        `#${stuck.ticket.number}: ${stuck.agentName} had stopped` +
        (stuck.said ? ` (${stuck.said})` : '') +
        ` — restarted automatically, resuming where it left off. Nothing was lost.`,
    })
    healed.push(stuck.ticket.number)
  }

  if (healed.length > 0) {
    flushWrites()
    bus.emitDomain({ type: 'messages:changed', projectId })
    bus.emitDomain({ type: 'agents:changed', projectId })
  }

  return healed
}

/**
 * Out of automatic options — say so, once, everywhere that survives a dead Pilot.
 *
 * `notifyUser` and the message row both work with no Pilot process; `pilot.notify` is a
 * best-effort extra. That ordering matters: the failure this handles is frequently *why* the
 * Pilot is not running.
 */
function escalate(projectId: string, stuck: StuckStep, manualOnly: boolean): void {
  const key = `${stuck.agentId}:${stuck.ticket.id}`
  if (escalated.has(key)) return
  escalated.add(key)

  const why = manualOnly
    ? `#${stuck.ticket.number} is assigned to ${stuck.agentName} but nothing is running it. ` +
      `This project starts work only when you say so, so it is waiting for you.`
    : `#${stuck.ticket.number} stopped again after being restarted automatically` +
      (stuck.said ? ` — ${stuck.said}` : '') +
      `. It needs you now: restart it from the agents panel, or hand the step to someone else.`

  addMessage({
    projectId,
    agentId: null,
    authorType: 'system',
    kind: manualOnly ? 'notice' : 'error',
    body: why,
  })
  flushWrites()
  bus.emitDomain({ type: 'messages:changed', projectId })

  if (!manualOnly) {
    notifyUser({
      projectId,
      title: `#${stuck.ticket.number} is stuck`,
      body: `${stuck.agentName} stopped twice. ${stuck.ticket.title}`,
    })
    pilot.notify(projectId, why)
  }
}
