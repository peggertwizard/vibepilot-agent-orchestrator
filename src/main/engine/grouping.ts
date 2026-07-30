import type { Ticket } from '@shared/types'
import { getTicket, listTickets } from '../db/repos/tickets'

/**
 * Which tickets share a branch.
 *
 * Three tickets from one request produced three branches, three worktrees at ~39 MB each, and
 * three separate merges — for pieces that mostly ran in sequence. *"why would I need for those
 * tickets 3 different branches? isn't that overkill?"*
 *
 * The obvious answers are both wrong. **Per ticket** is what produced the mess. **Per request**
 * fails on the question that followed: *"what defines one request? what if in one message I
 * mention totally different unrelated things?"* — a message is not a unit of work.
 *
 * The unit is **what must land together**, and vibePilot can already tell:
 *
 *   - `dependsOn` — B needs A, so B is built on top of A. Separate branches here is the exact
 *     shape that broke: #3 branched from main before #4 landed, so merging #3 afterwards would
 *     have brought back what #4 removed.
 *   - `epicId` — pieces of one breakdown, when they also depend on each other.
 *
 * Anything genuinely independent keeps its own branch and can still run in parallel. So two
 * unrelated asks in one message stay properly separate, which is what the question was really
 * about.
 */

/**
 * The branch key for a ticket: the lowest ticket number in its dependency-connected group.
 *
 * Lowest rather than, say, the epic id, because it has to be **stable** — a group that changed
 * its key when a ticket was added would strand the branch that already exists. Ticket numbers
 * only ever go up, so the lowest is fixed once the group has formed.
 */
export function branchGroupFor(ticketId: string): { number: number; title: string } | null {
  const t = getTicket(ticketId)
  if (!t) return null

  const all = listTickets(t.projectId)
  const byNumber = new Map(all.map((x) => [x.number, x]))

  /*
   * Walk the dependency graph in both directions.
   *
   * Both, because "A must land before B" makes them one unit regardless of which end you start
   * from — and following only one direction would give two tickets in the same chain different
   * answers, which is worse than not grouping at all.
   */
  const seen = new Set<number>()
  const queue: number[] = [t.number]

  while (queue.length > 0) {
    const n = queue.pop()!
    if (seen.has(n)) continue
    seen.add(n)

    const cur = byNumber.get(n)
    if (!cur) continue

    // Things this one waits for.
    for (const dep of cur.dependsOn) if (!seen.has(dep)) queue.push(dep)
    // Things that wait for it.
    for (const other of all) {
      if (other.dependsOn.includes(n) && !seen.has(other.number)) queue.push(other.number)
    }
  }

  const lowest = Math.min(...seen)
  const owner = byNumber.get(lowest)
  return owner ? { number: owner.number, title: owner.title } : null
}

/**
 * Does this ticket share a branch with others, and which?
 *
 * For the card, so a shared branch is something the board tells you rather than something you
 * work out from two tickets having the same branch name.
 */
export function groupMembers(ticket: Ticket): number[] {
  const group = branchGroupFor(ticket.id)
  if (!group) return []
  return listTickets(ticket.projectId)
    .filter((t) => branchGroupFor(t.id)?.number === group.number)
    .map((t) => t.number)
    .sort((a, b) => a - b)
}
