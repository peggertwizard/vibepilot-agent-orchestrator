import type { Project, Ticket } from '@shared/types'
import { bus } from '../bus'
import { getProject } from '../db/repos/projects'
import { getTicket, listTickets, updateTicket } from '../db/repos/tickets'
import { acceptedRoute } from '../db/repos/routes'
import { unmetDependencies } from '../db/repos/epics'
import { addMessage } from '../db/repos/messages'
import { flushWrites } from '../db/writer'
import { squashMerge, syncWithBase } from '../git/worktree'
import { commitsAhead, currentBranch } from '../git/branches'
import { notifyUser } from '../notify'
import { pilot } from './pilot'
import { routing } from './routing'
import { stopPreview } from './preview'
import { sweepEmptyReady } from './board'
import { groupMembers } from './grouping'
import { clearSyncReport } from './sync'
import { worktreeDir } from '../paths'

/**
 * Merging, as something that happens rather than something you do.
 *
 * The old arrangement made every merge a button, on the reasoning that merging is "where work
 * becomes real". Using it showed the cost: a chain of finished tickets became a queue of merge
 * buttons, each blocked by the one above, the whole thing jammed on unsaved work that turned
 * out to be vibePilot's own memory folder — and #8 sat waiting on #6 and #7 for as long as the
 * human took to notice. The autonomy the app exists for drained away into "waiting for you".
 *
 * What is actually irreversible is further along:
 *
 *   - **push** — the work leaves this machine
 *   - **deploy** — the work reaches other people
 *
 * Both stay behind buttons, at every setting. A local squash-merge is inspectable with
 * `git show`, revertable with `git reset --hard`, and announced in the message log every time.
 *
 * Everything below is shared by the button and the automatic path deliberately: one code path
 * means the guarantees cannot differ between them, and the automatic one is not a shortcut
 * around the checks the manual one performs.
 */

export type MergeOutcome =
  | { ok: true; sha: string; freedBytes: number; setAsideNote: string | null }
  | {
      ok: false
      /** `waiting` is a shared branch whose other tickets are not done — see `groupMembers`. */
      kind: 'dirty' | 'conflict' | 'error' | 'empty' | 'waiting'
      reason: string
      conflicts: string[]
    }

/**
 * Should this finished ticket merge on its own?
 *
 * Every reason to say no is a reason a *person* should look at it. Nothing here is about
 * whether the merge would succeed — `mergeTicket` finds that out honestly and stops.
 */
export function shouldAutoMerge(
  project: Project,
  ticket: Ticket,
  checksPassed: boolean | null,
): { yes: boolean; why: string } {
  if (project.autoMerge === 'off') return { yes: false, why: 'Auto-merge is off for this project.' }
  if (!ticket.branch) return { yes: false, why: 'No branch.' }
  if (ticket.mergeState === 'merged') return { yes: false, why: 'Already merged.' }

  /*
   * A conflict from a previous attempt is a decision waiting for a person. Retrying it
   * automatically would just fail again, every time, and bury the message that explains why.
   */
  if (ticket.mergeState === 'conflict') {
    return { yes: false, why: 'It has a conflict, which is yours to resolve.' }
  }

  if (project.autoMerge === 'green' && checksPassed === false) {
    return { yes: false, why: 'The checks did not pass.' }
  }
  /*
   * `null` means no checks are configured — not that they failed. Under `green` that would
   * block every merge for ever on a project with no test command, which is a silent way to
   * turn the feature off for the people most likely to want it.
   */
  return { yes: true, why: checksPassed === true ? 'Checks passed.' : 'Route complete.' }
}

/**
 * Merge one ticket into the base branch. Used by the button and by the automatic path.
 *
 * `auto` changes only what is *said*, never what is *checked* — the same refusals apply
 * either way. That symmetry is the point: an automatic merge is the same operation, without
 * the wait.
 */
export async function mergeTicket(
  ticketId: string,
  opts: { setAside?: boolean; auto?: boolean } = {},
): Promise<MergeOutcome> {
  const ticket = getTicket(ticketId)
  if (!ticket) return { ok: false, kind: 'error', reason: 'That ticket no longer exists.', conflicts: [] }
  const project = getProject(ticket.projectId)
  if (!project) return { ok: false, kind: 'error', reason: 'That project no longer exists.', conflicts: [] }
  if (!ticket.branch) {
    return {
      ok: false,
      kind: 'error',
      reason: 'This ticket has no branch — nothing was ever built for it.',
      conflicts: [],
    }
  }

  /*
   * Nothing on the branch. Not a failure — the work landed some other way, or never started.
   * Merging an empty branch produces an empty commit and a ticket that claims to have done
   * something. `sweepEmptyReady` settles these properly.
   */
  const ahead = await commitsAhead(project.path, project.defaultBaseBranch, ticket.branch).catch(
    () => 0,
  )
  if (ahead === 0) {
    await sweepEmptyReady(project.id)
    return {
      ok: false,
      kind: 'empty',
      reason: `\`${ticket.branch}\` has no commits on it, so there is nothing to merge.`,
      conflicts: [],
    }
  }

  /*
   * A shared branch merges as a unit, or not at all.
   *
   * This is the cost of grouping, and it has to be paid explicitly: when #6 and #8 share a
   * branch, merging #6 alone would land #8's half-written work under #6's name. So the branch
   * waits until everything on it is finished — which is also what "these must land together"
   * meant in the first place.
   */
  const together = groupMembers(ticket).filter((n) => n !== ticket.number)
  if (together.length > 0) {
    const unfinished = together
      .map((n) => listTickets(project.id).find((x) => x.number === n))
      .filter((x): x is Ticket => !!x)
      .filter((x) => !x.readyToMerge && x.mergeState !== 'merged' && x.lane !== 'done')

    if (unfinished.length > 0) {
      return {
        ok: false,
        kind: 'waiting',
        reason:
          `#${ticket.number} shares a branch with ` +
          `${unfinished.map((x) => `#${x.number}`).join(', ')}, which ${
            unfinished.length === 1 ? 'is' : 'are'
          } not finished. They were built on top of each other, so they land together.`,
        conflicts: [],
      }
    }
  }

  updateTicket(ticketId, { mergeState: 'cpd_running' })
  bus.emitDomain({ type: 'tickets:changed', projectId: project.id })

  /*
   * Level with the base before merging into it.
   *
   * The heartbeat normally keeps this at zero, so on a healthy project this does nothing. It
   * is here because the heartbeat can only sync what it can reach — a project added minutes
   * ago, an app that was closed while the base moved, a branch merged the moment its last step
   * finished — and a merge is the exact moment the gap stops being harmless.
   *
   * Where the conflict surfaces is the whole point. Reconciling here means git stops halfway
   * through the *user's own project folder*, on files they never edited, over a disagreement
   * between two agents. Reconciling in the worktree leaves that folder untouched and puts the
   * conflict on the branch that owns it.
   */
  const synced = await syncWithBase({
    repo: project.path,
    worktree: worktreeDir(project.path, ticket.number),
    branch: ticket.branch,
    baseBranch: project.defaultBaseBranch,
  })
  if (!synced.ok && synced.conflicts.length > 0) {
    updateTicket(ticketId, { mergeState: 'conflict', conflictFiles: synced.conflicts })
    addMessage({
      projectId: project.id,
      authorType: 'system',
      kind: 'error',
      body:
        `#${ticket.number} could not be merged: it is ${synced.behind} ` +
        `${synced.behind === 1 ? 'commit' : 'commits'} behind ${project.defaultBaseBranch}, and ` +
        `bringing it up to date runs into changes that have already landed.\n\n` +
        `Conflicting files:\n${synced.conflicts.map((f) => `  ${f}`).join('\n')}\n\n` +
        `Your project folder was not touched. The disagreement is on \`${ticket.branch}\`, ` +
        `which is where it has to be settled.`,
    })
    flushWrites()
    bus.emitDomain({ type: 'tickets:changed', projectId: project.id })
    bus.emitDomain({ type: 'messages:changed', projectId: project.id })
    if (opts.auto) {
      notifyUser({
        projectId: project.id,
        title: `#${ticket.number} needs you`,
        body: `It clashes with work already on ${project.defaultBaseBranch}.`,
      })
    }
    return {
      ok: false,
      kind: 'conflict',
      reason:
        `#${ticket.number} is ${synced.behind} ${synced.behind === 1 ? 'commit' : 'commits'} ` +
        `behind ${project.defaultBaseBranch} and clashes with what landed meanwhile.`,
      conflicts: synced.conflicts,
    }
  }

  const result = await squashMerge({
    repo: project.path,
    branch: ticket.branch,
    baseBranch: project.defaultBaseBranch,
    message: `vp(#${ticket.number}): ${ticket.title}`,
    setAside: opts.setAside,
  })

  if (!result.ok) {
    /*
     * A dirty working copy is not a conflict. A ticket whose branch is perfectly mergeable
     * used to get a red CONFLICT badge because *you* had uncommitted work, which reads as
     * "the agent's changes clash with main" and sends you hunting a problem that is not there.
     */
    updateTicket(ticketId, {
      mergeState:
        result.kind === 'dirty' ? 'ready' : result.kind === 'conflict' ? 'conflict' : 'failed',
      conflictFiles: result.conflicts,
    })
    addMessage({
      projectId: project.id,
      authorType: 'system',
      kind: 'error',
      body:
        `#${ticket.number} could not be merged: ${result.reason}` +
        (result.conflicts.length
          ? `\n\nConflicting files:\n${result.conflicts.map((f) => `  ${f}`).join('\n')}`
          : '') +
        '\n\nYour repository was left exactly as it was.',
    })
    flushWrites()
    bus.emitDomain({ type: 'tickets:changed', projectId: project.id })
    bus.emitDomain({ type: 'messages:changed', projectId: project.id })

    // An automatic merge that stops has to be as loud as one you asked for, or it is a silent
    // failure sitting behind a lane that looks fine.
    if (opts.auto) {
      notifyUser({
        projectId: project.id,
        title: `#${ticket.number} needs you`,
        body: result.reason,
      })
    }

    pilot.notify(
      project.id,
      result.kind === 'dirty'
        ? `#${ticket.number} could not be merged because the user's own working copy has ` +
            `uncommitted changes. Nothing was attempted and the branch is fine — it merges the ` +
            `moment they commit or set them aside. Do not send anyone to rebase anything.`
        : `Merging #${ticket.number} failed: ${result.reason}. ` +
            (result.conflicts.length ? `Conflicts in: ${result.conflicts.join(', ')}. ` : '') +
            `The branch is untouched.`,
    )
    return { ok: false, kind: result.kind, reason: result.reason, conflicts: result.conflicts }
  }

  // Nothing left to preview: the change is on the base branch and the worktree is going away.
  stopPreview(ticketId)

  /*
   * Everything on the branch, not just the ticket that triggered it.
   *
   * A grouped branch carries every ticket in the chain, so one squash-merge lands all of them.
   * Marking only the trigger would leave the others sitting in Waiting for you against a
   * branch that no longer has anything to give — the ghost state from 8d, manufactured fresh.
   */
  const landed = [ticket.number, ...together]
  for (const n of landed) {
    const x = listTickets(project.id).find((y) => y.number === n)
    if (!x) continue
    updateTicket(x.id, {
      mergeState: 'merged',
      lane: 'done',
      stage: null,
      readyToMerge: false,
      headSha: result.sha,
    })
    clearSyncReport(x.id)
  }
  if (together.length > 0) {
    addMessage({
      projectId: project.id,
      authorType: 'system',
      kind: 'notice',
      body:
        `#${together.join(', #')} landed with #${ticket.number} — they shared a branch because ` +
        `they were built on top of each other.`,
    })
  }
  /*
   * Landed — but possibly not where you are looking.
   *
   * A merge into the base branch changes nothing on screen if the project folder is checked
   * out somewhere else, and a dev server watching that folder keeps serving the old page. That
   * combination reads as "the merge did not work", and every obvious explanation for it is
   * wrong. Said here, at the one moment it becomes true.
   */
  const here = await currentBranch(project.path).catch(() => null)
  if (here && here !== project.defaultBaseBranch) {
    addMessage({
      projectId: project.id,
      agentId: null,
      authorType: 'system',
      kind: 'notice',
      body:
        `Careful: this landed on ${project.defaultBaseBranch}, but your project folder is ` +
        `checked out on \`${here}\`. Anything watching that folder — a dev server, a ` +
        `container — is still showing ${here}, not the merged work. Switching the folder back ` +
        `is one press in the list of things waiting on you.`,
    })
  }

  flushWrites()

  return {
    ok: true,
    sha: result.sha,
    freedBytes: 0,
    setAsideNote: result.setAside
      ? (result.restoreNote ??
        'Your unsaved changes were set aside for the merge and are back where they were.')
      : null,
  }
}

/**
 * Work that was waiting on a merge, and now is not.
 *
 * `unmetDependencies` was enforced correctly and reported nowhere, so when #6 landed, #8 simply
 * became startable — silently, with no line anywhere saying why it had been waiting or that it
 * no longer was. Watching #7 finish before #6 while #8 sat still is what that looks like from
 * the outside, and it reads as the app being stuck.
 *
 * Returns the ticket numbers freed, so the caller can name them.
 */
export function freeDependents(projectId: string): number[] {
  const freed: number[] = []

  for (const t of listTickets(projectId)) {
    if (t.mergeState === 'merged' || t.lane === 'done') continue
    if (t.dependsOn.length === 0) continue
    // Still waiting on something else — not this merge's business.
    if (unmetDependencies(projectId, t.id).length > 0) continue

    /*
     * Only tickets that were actually held. One with an accepted, already-running route was
     * never blocked, and announcing it as "unblocked" would be noise about a non-event.
     */
    const route = acceptedRoute(t.id)
    const started = route?.steps.some((s) => s.status !== 'pending') ?? false
    if (started) continue

    freed.push(t.number)
  }

  if (freed.length > 0) {
    addMessage({
      projectId,
      agentId: null,
      authorType: 'system',
      kind: 'notice',
      body:
        freed.length === 1
          ? `#${freed[0]} is no longer waiting — what it depended on has landed.`
          : `${freed.map((n) => `#${n}`).join(', ')} are no longer waiting — what they ` +
            `depended on has landed.`,
    })
    flushWrites()
    bus.emitDomain({ type: 'tickets:changed', projectId })
    bus.emitDomain({ type: 'messages:changed', projectId })

    /*
     * And actually start them, if the project says work may start by itself. Without this the
     * chain still stops dead at every link — the board would just be honest about why.
     */
    routing.startUnblocked(projectId, freed)
  }

  return freed
}
