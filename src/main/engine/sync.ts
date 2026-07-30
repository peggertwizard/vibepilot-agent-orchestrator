import { bus } from '../bus'
import { addMessage } from '../db/repos/messages'
import { getProject } from '../db/repos/projects'
import { listTickets, updateTicket } from '../db/repos/tickets'
import { flushWrites } from '../db/writer'
import { git } from '../git/repo'
import { syncWithBase } from '../git/worktree'
import { worktreeDir } from '../paths'

/**
 * Keeping open branches level with the base, so merging is boring.
 *
 * The conflicts this exists to remove were not really merge failures. A ticket branch was cut
 * from the base at ticket start and never updated again, so every ticket that landed made
 * every other open branch staler, and the merge at the end had to reconcile a gap that had
 * been quietly widening for days. On a real project: four open branches, 9 to 12 commits
 * behind, all four editing the same three files. Every one of them conflicted, and none of
 * them had anything wrong with it.
 *
 * The gap is the bug, so the gap gets closed continuously rather than survived at the end.
 * Landing #4 makes #3 one commit stale; this brings it level again on the next tick, while
 * #3's agent is still running and the difference is a handful of lines it understands.
 *
 * When it *cannot* be closed automatically, that is real news — two pieces of work genuinely
 * disagree about the same lines — and it is said once, in the worktree where it can be
 * resolved, rather than discovered by the user at merge time in their own project folder.
 */

/**
 * Which base commit we last reported a conflict at, per ticket.
 *
 * The guard is against repetition, not against reporting: a three-minute tick that cannot
 * merge produces the same failure every three minutes for ever, and an inbox full of one
 * sentence is the same as no inbox. Keyed by the base sha, so when the base moves the
 * situation has genuinely changed and it is worth saying again.
 */
const reportedAt = new Map<string, string>()

/** Called when a ticket merges or is dropped, so a later stall earns a fresh report. */
export function clearSyncReport(ticketId: string): void {
  reportedAt.delete(ticketId)
}

export async function syncTicketBranches(projectId: string): Promise<void> {
  const project = getProject(projectId)
  if (!project) return

  let baseSha = ''
  try {
    baseSha = (await git(project.path, ['rev-parse', project.defaultBaseBranch])).trim()
  } catch {
    // No base branch to be behind. Nothing here is worth guessing about.
    return
  }

  let told = false

  for (const ticket of listTickets(projectId)) {
    if (ticket.archivedAt || !ticket.branch) continue
    /*
     * Merged work is finished work. Its branch may well be behind the base — of course it is,
     * the base moved on afterwards — and updating it would achieve nothing but noise.
     */
    if (ticket.mergeState === 'merged') continue

    const result = await syncWithBase({
      repo: project.path,
      worktree: worktreeDir(project.path, ticket.number),
      branch: ticket.branch,
      baseBranch: project.defaultBaseBranch,
    })

    if (result.ok) {
      /*
       * Silence on success, deliberately. This runs every few minutes on every open ticket and
       * succeeds nearly always; a line each time would bury the ones that matter. What it did
       * is visible where it belongs — in the branch's own history.
       */
      if (reportedAt.has(ticket.id)) {
        reportedAt.delete(ticket.id)
        if (ticket.mergeState === 'conflict') {
          updateTicket(ticket.id, { mergeState: ticket.readyToMerge ? 'ready' : 'none', conflictFiles: [] })
          told = true
        }
      }
      continue
    }

    // Nothing to resolve and nowhere to resolve it — a ticket with no working copy is not a
    // conflict, it is a ticket nobody is working on. `sweepEmptyReady` handles the rest.
    if (result.conflicts.length === 0) continue

    if (reportedAt.get(ticket.id) === baseSha) continue
    reportedAt.set(ticket.id, baseSha)

    updateTicket(ticket.id, { mergeState: 'conflict', conflictFiles: result.conflicts })
    addMessage({
      projectId,
      agentId: null,
      authorType: 'system',
      kind: 'error',
      body:
        `#${ticket.number} and ${project.defaultBaseBranch} both changed the same lines, so ` +
        `\`${ticket.branch}\` could not be brought up to date automatically.\n\n` +
        result.conflicts.map((f) => `  ${f}`).join('\n') +
        `\n\nIt was ${result.behind} ${result.behind === 1 ? 'commit' : 'commits'} behind. Its ` +
        `working copy was left exactly as it was, and your project folder was not touched — ` +
        `the disagreement is between #${ticket.number} and work that has already landed, and ` +
        `it has to be settled on the branch before this can merge.`,
    })
    told = true
  }

  if (told) {
    flushWrites()
    bus.emitDomain({ type: 'tickets:changed', projectId })
    bus.emitDomain({ type: 'messages:changed', projectId })
  }
}
