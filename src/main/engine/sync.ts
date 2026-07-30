import { bus } from '../bus'
import { addMessage } from '../db/repos/messages'
import { getProject } from '../db/repos/projects'
import { listTickets, updateTicket } from '../db/repos/tickets'
import { flushWrites } from '../db/writer'
import { git } from '../git/repo'
import { ensureWorktree, syncWithBase } from '../git/worktree'
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

    const where = worktreeDir(project.path, ticket.number)
    const attempt = (): ReturnType<typeof syncWithBase> =>
      syncWithBase({
        repo: project.path,
        worktree: where,
        branch: ticket.branch as string,
        baseBranch: project.defaultBaseBranch,
      })

    let result = await attempt()

    /*
     * No working copy, but work that still needs to land.
     *
     * The worktree is removed once a ticket merges, and it can also be pruned, deleted, or
     * lost to a reinstall. A branch in that state was *unreachable*: nothing could update it,
     * so it stayed however stale it was and every merge attempt failed the same way for ever.
     * That is what a merge card you cannot act on actually is — not a mystery, a branch with
     * nowhere left to do the work. Giving it a working copy back costs one `git worktree add`.
     */
    if (!result.ok && result.behind > 0 && result.conflicts.length === 0) {
      try {
        await ensureWorktree({
          projectPath: project.path,
          ticketNumber: ticket.number,
          title: ticket.title,
          baseBranch: project.defaultBaseBranch,
        })
        result = await attempt()
      } catch {
        // A worktree that cannot be made is not something to report every three minutes.
        continue
      }
    }

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
