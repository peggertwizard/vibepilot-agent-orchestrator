import { bus } from '../bus'
import { getProject } from '../db/repos/projects'
import { getTicket } from '../db/repos/tickets'
import { addMessage } from '../db/repos/messages'
import { flushWrites } from '../db/writer'
import { notifyUser } from '../notify'
import { pilot } from './pilot'
import { lastChecksFor } from './checks'
import { freeDependents, mergeTicket, shouldAutoMerge } from './merge'

/**
 * The moment a ticket finishes: land it, or say why not.
 *
 * Kept apart from `merge.ts` so the *decision* and the *operation* stay separable — the button
 * calls `mergeTicket` directly and must not accidentally acquire this policy, and this policy
 * is the thing most likely to be argued with later.
 *
 * Returns whether the work landed. `false` means it is waiting for you, and something has
 * already been written explaining what.
 */
export async function autoMergeFinished(ticketId: string): Promise<boolean> {
  const ticket = getTicket(ticketId)
  if (!ticket) return false
  const project = getProject(ticket.projectId)
  if (!project) return false

  /*
   * Did the checks pass?
   *
   * `null` means none were run — which under `green` is treated as permission rather than
   * failure. A project with no test command configured would otherwise never auto-merge
   * anything, silently, which is the least useful possible reading of "when checks pass".
   */
  const checks = lastChecksFor(ticket.assigneeAgentId)
  const checksPassed = checks === null ? null : checks.every((c) => c.ok)

  const verdict = shouldAutoMerge(project, ticket, checksPassed)
  if (!verdict.yes) return false

  const result = await mergeTicket(ticketId, { auto: true })
  if (!result.ok) {
    /*
     * A shared branch waiting for its siblings is not a problem and needs no alarm — it is the
     * grouping working. Say it once, quietly, and let the last ticket in the chain land them
     * all. Everything else has already been written, notified and sent to the Pilot.
     */
    if (result.kind === 'waiting') {
      addMessage({
        projectId: project.id,
        agentId: null,
        authorType: 'system',
        kind: 'notice',
        body: `#${ticket.number} is done and waiting for the rest of its branch. ${result.reason}`,
      })
      flushWrites()
      bus.emitDomain({ type: 'messages:changed', projectId: project.id })
      return true
    }
    return false
  }

  addMessage({
    projectId: project.id,
    agentId: null,
    authorType: 'system',
    kind: 'notice',
    body:
      `#${ticket.number} merged into ${project.defaultBaseBranch} on its own ` +
      `(${result.sha.slice(0, 7)}) — ${verdict.why.toLowerCase()} Nothing has been pushed or ` +
      `deployed.` +
      (result.setAsideNote ? `\n\n${result.setAsideNote}` : ''),
  })

  /*
   * Announced, always. "Work starts on its own, it never starts invisibly" applies just as
   * much to work finishing — six things landing unnoticed is the failure mode this feature
   * has to be defended against, and the message log plus this notification are the defence.
   */
  notifyUser({
    projectId: project.id,
    title: `#${ticket.number} merged`,
    body: `${ticket.title} — on ${project.defaultBaseBranch}, not pushed.`,
  })

  flushWrites()
  bus.emitDomain({ type: 'tickets:changed', projectId: project.id })
  bus.emitDomain({ type: 'messages:changed', projectId: project.id })

  // Whatever was waiting on this ticket is now free, and may begin.
  const freed = freeDependents(project.id)

  pilot.notify(
    project.id,
    `#${ticket.number} finished and merged itself into ${project.defaultBaseBranch}. ` +
      (freed.length
        ? `That unblocked ${freed.map((n) => `#${n}`).join(', ')}, which ${
            freed.length === 1 ? 'is' : 'are'
          } now free to start. `
        : '') +
      `Nothing was pushed or deployed. Say one short line about what landed — do not restate ` +
      `the whole ticket.`,
  )

  return true
}
