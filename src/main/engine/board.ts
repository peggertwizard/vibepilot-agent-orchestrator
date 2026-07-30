import type { Ticket } from '@shared/types'
import { derivePlacement } from '@shared/board'
import { LIVE_STATUSES } from '@shared/types'
import { getAgent } from '../db/repos/agents'
import { getProject } from '../db/repos/projects'
import { archiveTicket, listTickets, updateTicket } from '../db/repos/tickets'
import { addMessage } from '../db/repos/messages'
import { hasLanded } from '../git/repo'
import { flushWrites } from '../db/writer'
import { bus } from '../bus'
import { acceptedRoute } from '../db/repos/routes'
import { unmetDependencies } from '../db/repos/epics'
import { activeStep } from '@shared/types'
import { isQueued } from './gate'
import { manager } from './manager'

/**
 * Stamp the real lane onto tickets on their way out of the database.
 *
 * Every read path that ends up on a screen or in the Pilot's prompt goes through here. That
 * is the whole mechanism: there is no reconciler to forget to run and no write path to keep
 * in sync, because the value is computed at the moment it is asked for, from the route and
 * the process table rather than from whatever the last writer left behind.
 *
 * `manager.forAgent` is a live map, not a database read, so this costs nothing worth
 * measuring even on a board with a hundred cards.
 */

function factsFor(t: Ticket): Parameters<typeof derivePlacement>[0] {
  const route = acceptedRoute(t.id)
  const step = activeStep(route)
  const assigneeId = step?.assigneeAgentId ?? t.assigneeAgentId ?? null
  const agent = assigneeId ? getAgent(assigneeId) : null

  return {
    merged: t.mergeState === 'merged' || t.lane === 'done',
    readyToMerge: t.readyToMerge,
    route,
    /*
     * Both halves are required. A live process with a `done` status is an agent on its way
     * out; a live status with no process is the stall this whole file exists to surface.
     */
    assigneeLive: Boolean(
      agent && LIVE_STATUSES.includes(agent.status) && manager.forAgent(agent.id),
    ),
    assigneeQueued: Boolean(agent && (agent.status === 'queued' || isQueued(agent.id))),
  }
}

/** One ticket, placed. */
export function place(t: Ticket): Ticket {
  const p = derivePlacement(factsFor(t))
  return {
    ...t,
    lane: p.lane,
    stuck: p.stuck,
    laneBecause: p.because,
    // Only what is genuinely still in the way. A dependency that has landed is not a wait.
    waitingFor: t.dependsOn.length > 0 ? unmetDependencies(t.projectId, t.id) : [],
  }
}

/** Many tickets, placed. The only function the read paths call. */
export function placeAll(ts: Ticket[]): Ticket[] {
  return ts.map(place)
}

/**
 * Ready tickets whose branch has nothing on it.
 *
 * #5 in a real project sat in Waiting for you with a READY badge and an empty branch: it
 * reached ready before `mark_ready_to_merge` grew its commits-ahead guard, and the work had
 * actually landed by another route. Nothing swept it, so it queued behind itself for ever and
 * made the whole lane look broken.
 *
 * The guard stops new ghosts. This clears the ones already there, and keeps running so a
 * branch emptied some other way — a manual merge, a reset — cannot leave one behind either.
 *
 * Returns what it settled, so the caller can say so rather than the board silently changing.
 */
export async function sweepEmptyReady(projectId: string): Promise<Array<{ number: number }>> {
  const project = getProject(projectId)
  if (!project) return []

  const settled: Array<{ number: number }> = []
  for (const t of listTickets(projectId)) {
    if (!t.readyToMerge || t.mergeState === 'merged' || !t.branch) continue

    /*
     * `hasLanded` compares content. The old test counted commits, and a squash merge leaves
     * the branch's own commits exactly where they were — so this sweep, whose entire job is
     * settling branches with nothing left on them, could never see one. It returns false when
     * the comparison fails, so a branch that cannot be read is never declared empty.
     */
    if (!(await hasLanded(project.path, project.defaultBaseBranch, t.branch))) continue

    updateTicket(t.id, { readyToMerge: false, mergeState: 'none', lane: 'done' })
    addMessage({
      projectId,
      agentId: null,
      authorType: 'system',
      kind: 'notice',
      body:
        `#${t.number} had nothing left to merge — every line of \`${t.branch}\` is already on ` +
        `${project.defaultBaseBranch}. Moved to Done.`,
    })
    settled.push({ number: t.number })
  }

  if (settled.length > 0) {
    flushWrites()
    bus.emitDomain({ type: 'tickets:changed', projectId })
    bus.emitDomain({ type: 'messages:changed', projectId })
  }
  return settled
}

/**
 * Finished work leaves the board on its own.
 *
 * The Done column only ever grew. Everything the app had ever completed stayed on the one
 * screen that should say *here is what landed*, and the archive — which existed and worked —
 * was something you had to remember, one ticket at a time, from a menu behind an ellipsis.
 *
 * The predicate is `doneAt`, not the lane, and that distinction is the whole safety argument:
 * `updateTicket` stamps it on the way into done and clears it on the way out, so a ticket that
 * was dragged back to To do has no timestamp and cannot be collected however long it sits. A
 * ticket still waiting to merge is excluded outright — it is finished work, but it is not
 * *done with*, and archiving it would hide the merge card that is the point of it.
 *
 * Returns the numbers it archived so the caller can say so. Silence would make finished work
 * appear to vanish, which is the one way this feature could feel like data loss.
 */
export function sweepDoneTickets(projectId: string, now = Date.now()): number[] {
  const project = getProject(projectId)
  if (!project) return []

  const days = project.autoArchiveDays
  if (days <= 0) return []
  const cutoff = now - days * 86_400_000

  const archived: number[] = []
  for (const t of listTickets(projectId)) {
    if (t.doneAt === null || t.doneAt >= cutoff) continue
    if (t.readyToMerge) continue
    archiveTicket(t.id)
    archived.push(t.number)
  }

  if (archived.length > 0) {
    addMessage({
      projectId,
      agentId: null,
      authorType: 'system',
      kind: 'notice',
      body:
        `Archived ${archived.length === 1 ? 'one finished ticket' : `${archived.length} finished tickets`} ` +
        `(${archived.map((n) => `#${n}`).join(', ')}) — done for more than ${days} ` +
        `${days === 1 ? 'day' : 'days'}. They are still there under Archive.`,
    })
    flushWrites()
    bus.emitDomain({ type: 'tickets:changed', projectId })
    bus.emitDomain({ type: 'messages:changed', projectId })
  }

  return archived
}
