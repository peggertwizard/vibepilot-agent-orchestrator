import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  MACHINE_OWNED_PREFIX,
  blockingChanges,
  git,
  headSha,
  incomingFiles,
  isDirty,
} from './repo'
import { worktreeDir } from '../paths'

/** CRLF or LF, depending on git and the platform. */
const SPLIT = new RegExp('\r?\n')

/**
 * One git worktree per active ticket, so agents working in parallel never collide.
 *
 * Worktrees live OUTSIDE the project directory (%LOCALAPPDATA%\vibepilot\wt\...). Putting
 * them inside would blow past Windows' 260-char MAX_PATH the moment a real repo installs
 * node_modules inside one, and would need .gitignore surgery besides.
 *
 * CRITICAL: a Claude session is bound to the cwd it was created in — `--resume` from a
 * different directory fails with "No conversation found". So a worktree must NOT be removed
 * while its agent is still resumable. See docs/architecture/00-spikes.md.
 */

export function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'work'
  )
}

export function branchName(ticketNumber: number, title: string): string {
  return `vp/${ticketNumber}-${slugify(title)}`
}

/**
 * Is this a branch vibePilot made for a ticket?
 *
 * The question matters in exactly one place: the project folder. A ticket branch belongs in a
 * worktree — that is the whole arrangement — so the main checkout standing on one is never a
 * choice anybody made, it is always something that went wrong. Any *other* branch is the
 * user's business and gets left alone.
 */
export function isTicketBranch(branch: string | null): boolean {
  return !!branch && /^vp\/\d+-/.test(branch)
}

export interface WorktreeInfo {
  path: string
  branch: string
  baseSha: string
  created: boolean
}

export async function ensureWorktree(input: {
  projectPath: string
  ticketNumber: number
  title: string
  baseBranch: string
}): Promise<WorktreeInfo> {
  const path = worktreeDir(input.projectPath, input.ticketNumber)
  const branch = branchName(input.ticketNumber, input.title)

  // Already there and healthy — reuse it. Recreating would destroy uncommitted work and
  // break the agent's resume handle.
  if (existsSync(path)) {
    try {
      const sha = await headSha(path)
      return { path, branch, baseSha: sha, created: false }
    } catch {
      // Directory exists but isn't a working tree. Clear it only because git will refuse.
      rmSync(path, { recursive: true, force: true })
    }
  }

  mkdirSync(dirname(path), { recursive: true })

  const base = await resolveBase(input.projectPath, input.baseBranch)

  if (await branchExists(input.projectPath, branch)) {
    await git(input.projectPath, ['worktree', 'add', path, branch])
  } else {
    await git(input.projectPath, ['worktree', 'add', '-b', branch, path, base])
  }

  return { path, branch, baseSha: await headSha(path), created: true }
}

async function resolveBase(repo: string, baseBranch: string): Promise<string> {
  for (const ref of [baseBranch, 'HEAD']) {
    try {
      await git(repo, ['rev-parse', '--verify', ref])
      return ref
    } catch {
      /* try the next */
    }
  }
  return 'HEAD'
}

async function branchExists(repo: string, branch: string): Promise<boolean> {
  try {
    await git(repo, ['rev-parse', '--verify', `refs/heads/${branch}`])
    return true
  } catch {
    return false
  }
}

export interface WorktreeEntry {
  path: string
  branch: string | null
  head: string | null
}

export async function listWorktrees(repo: string): Promise<WorktreeEntry[]> {
  const out = await git(repo, ['worktree', 'list', '--porcelain'])
  const entries: WorktreeEntry[] = []
  let cur: Partial<WorktreeEntry> = {}
  for (const line of out.split('\n')) {
    const l = line.trim()
    if (l.startsWith('worktree ')) {
      if (cur.path) entries.push({ path: cur.path, branch: cur.branch ?? null, head: cur.head ?? null })
      cur = { path: l.slice(9) }
    } else if (l.startsWith('HEAD ')) {
      cur.head = l.slice(5)
    } else if (l.startsWith('branch ')) {
      cur.branch = l.slice(7).replace('refs/heads/', '')
    }
  }
  if (cur.path) entries.push({ path: cur.path, branch: cur.branch ?? null, head: cur.head ?? null })
  return entries
}

/**
 * Remove a worktree. Refuses when it has uncommitted changes unless forced — losing an
 * agent's unpushed work to a cleanup pass is unacceptable, and the reaper never forces.
 */
export async function removeWorktree(
  repo: string,
  path: string,
  opts: { force?: boolean } = {},
): Promise<{ removed: boolean; reason?: string }> {
  if (!existsSync(path)) return { removed: true }

  if (!opts.force) {
    try {
      if (await isDirty(path)) {
        return { removed: false, reason: 'It has uncommitted changes.' }
      }
    } catch {
      return { removed: false, reason: 'Could not read its state.' }
    }
  }

  try {
    await git(repo, ['worktree', 'remove', ...(opts.force ? ['--force'] : []), path])
    return { removed: true }
  } catch (e) {
    return { removed: false, reason: (e as Error).message }
  }
}

export async function pruneWorktrees(repo: string): Promise<void> {
  await git(repo, ['worktree', 'prune'])
}

export interface DiffStat {
  files: number
  insertions: number
  deletions: number
  commits: number
}

export async function diffStat(worktree: string, baseBranch: string): Promise<DiffStat> {
  const empty: DiffStat = { files: 0, insertions: 0, deletions: 0, commits: 0 }
  try {
    const stat = await git(worktree, ['diff', '--shortstat', `${baseBranch}...HEAD`])
    const commits = (await git(worktree, ['rev-list', '--count', `${baseBranch}..HEAD`])).trim()
    const files = /(\d+) files? changed/.exec(stat)?.[1]
    const ins = /(\d+) insertions?/.exec(stat)?.[1]
    const del = /(\d+) deletions?/.exec(stat)?.[1]
    return {
      files: Number(files ?? 0),
      insertions: Number(ins ?? 0),
      deletions: Number(del ?? 0),
      commits: Number(commits || 0),
    }
  } catch {
    return empty
  }
}

export interface ChangedFile {
  /** A, M, D, R… — git's own status letter. */
  status: string
  path: string
}

/**
 * Which files a branch actually touched.
 *
 * `diffStat` gives counts and throws the names away, which is enough for a one-line notice
 * and not enough for a report. This is the honest source for "what changed on this ticket":
 * a reconstruction from recorded tool calls would only ever be a guess, and teammates do not
 * record their tool calls anyway.
 */
export async function changedFiles(
  worktree: string,
  baseBranch: string,
  limit = 60,
): Promise<ChangedFile[]> {
  try {
    const out = await git(worktree, ['diff', '--name-status', `${baseBranch}...HEAD`])
    return out
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, limit)
      .map((l) => {
        const [status = '?', ...rest] = l.split(/\s+/)
        return { status, path: rest.join(' ') }
      })
      .filter((f) => f.path.length > 0)
  } catch {
    return []
  }
}

export interface SyncOutcome {
  ok: boolean
  /** How far behind the base the branch was *before* this ran. Zero means nothing to do. */
  behind: number
  /** Files git could not reconcile. Only ever populated when `ok` is false. */
  conflicts: string[]
  /** Why it could not be brought up to date. Absent on success. */
  reason?: string
}

/**
 * Bring a ticket branch up to date with the base, inside its own working copy.
 *
 * **This is the fix for the conflicts.** A ticket branch was cut from the base when the ticket
 * started and then left there for ever — nothing brought the base back into it. So every
 * ticket that landed made every *other* open branch staler, and by the time a branch reached
 * its own merge it was a small edit written against a version of the file that had stopped
 * existing ten commits ago. Measured on a real project: four open branches, each 9 to 12
 * commits behind, all four editing the same three files. Conflicts there were not bad luck,
 * they were arithmetic — and no amount of care at merge time could have avoided them, because
 * by merge time the gap was already ten commits wide.
 *
 * Two things matter about *where* this runs:
 *
 *   - **In the worktree, not the project folder.** Conflicts land where the agent already is,
 *     on the branch they belong to, without touching what the user is looking at. The old
 *     behaviour surfaced them in the main checkout at merge time, which is both the worst
 *     place to find one and the worst moment.
 *   - **Early and often.** Run on the heartbeat, the gap is never more than one landed ticket
 *     wide, so a conflict is a handful of lines while the agent that wrote them is still
 *     running. Left to merge time it is the sum of everything that happened meanwhile.
 *
 * A real merge, not a rebase: it records the base as an ancestor, so the next sync starts from
 * here rather than replaying the same ten commits, and it never rewrites a commit an agent's
 * session is holding a reference to.
 */
export async function syncWithBase(input: {
  repo: string
  worktree: string
  branch: string
  baseBranch: string
}): Promise<SyncOutcome> {
  let behind = 0
  try {
    const out = await git(input.repo, [
      'rev-list',
      '--count',
      `${input.branch}..${input.baseBranch}`,
    ])
    behind = Number(out.trim()) || 0
  } catch {
    // A gap that cannot be measured is not a gap worth acting on. Same reasoning as
    // `sweepEmptyReady`: never touch a branch on the strength of a failed question.
    return { ok: true, behind: 0, conflicts: [] }
  }
  if (behind === 0) return { ok: true, behind: 0, conflicts: [] }

  if (!existsSync(input.worktree)) {
    return { ok: false, behind, conflicts: [], reason: 'It has no working copy to update in.' }
  }

  try {
    await git(input.worktree, ['merge', '--no-edit', input.baseBranch])
    return { ok: true, behind, conflicts: [] }
  } catch (e) {
    let conflicts: string[] = []
    try {
      const out = await git(input.worktree, ['diff', '--name-only', '--diff-filter=U'])
      conflicts = out.split(SPLIT).map((s) => s.trim()).filter(Boolean)
    } catch {
      /* nothing more to learn */
    }
    /*
     * Leave the working copy exactly as it was. A worktree stopped mid-merge is a worktree the
     * agent cannot commit in, and it would be stopped there by *housekeeping* — a background
     * tick the user never asked for breaking the thing it was tidying.
     */
    await git(input.worktree, ['merge', '--abort']).catch(() => undefined)
    return {
      ok: false,
      behind,
      conflicts,
      reason: (e as Error).message.split(SPLIT).filter(Boolean)[0] ?? 'The update did not apply.',
    }
  }
}

/**
 * Squash-merge a finished branch into the base branch, in the main working copy.
 * Deliberately local: no push, no PR. Nothing leaves the machine unless the user does it.
 */
export async function squashMerge(input: {
  repo: string
  branch: string
  baseBranch: string
  message: string
  /** Put the user's own uncommitted work aside for the merge and give it straight back. */
  setAside?: boolean
}): Promise<
  | { ok: true; sha: string; setAside: boolean; restoreNote: string | null }
  /**
   * `kind` exists because "could not merge" covers two completely different situations and
   * only one of them is about the branch.
   *
   * `dirty` means **you** have uncommitted work — the branch is perfectly mergeable and nothing
   * was attempted. Labelling that a conflict is alarming and wrong: it reads as "the agent's
   * work clashes with main", when the truth is "tidy your desk first".
   */
  /** `empty` means the branch had nothing left to give — its work is already on the base. */
  | { ok: false; kind: 'dirty' | 'conflict' | 'error' | 'empty'; reason: string; conflicts: string[] }
> {
  const original = (await git(input.repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()

  /*
   * vibePilot's own files, out of the way first.
   *
   * `.vibepilot/memory/` is written continuously by `remember` and the curator. When that
   * folder is tracked, every memory write dirties the tree — so the check below saw unsaved
   * work and refused, every time, on changes the user never made. Three merge cards in a row
   * blocked by the app's own diary.
   *
   * Committed rather than stashed: it is real content worth keeping in git (memory that
   * survives a fresh clone), and stashing it would only move the problem to the pop. One
   * commit, one standard message, greppable later, and scoped to nothing but this folder.
   */
  await commitMachineOwned(input.repo)

  /*
   * Your own unsaved work.
   *
   * Without `setAside` this stops and says so — merging on top of your changes would mix them
   * with the agent's. With it, vibePilot puts them safely to one side, merges, and puts them
   * straight back. Never automatic: quietly moving someone's uncommitted work is exactly the
   * thing that makes a tool feel unsafe, however reversible it is underneath.
   */
  let setAside = false
  /*
   * Only what the incoming work actually touches.
   *
   * A generated file the app rewrites on every run — `importMap.js`, a build stamp, a lockfile
   * — leaves the tree permanently dirty, and the old guard refused every merge in that project
   * for ever on the strength of it. If the branch does not touch the file, merging cannot harm
   * it: git leaves the working-tree change exactly where it is.
   *
   * `null` means the comparison itself failed, and then the honest fallback is the old
   * behaviour — treat every tracked change as blocking rather than claim nothing is.
   */
  const incoming = await incomingFiles(input.repo, input.baseBranch, input.branch)
  const blocking = await blockingChanges(input.repo, incoming ?? undefined)
  if (blocking.length > 0) {
    if (!input.setAside) {
      return {
        ok: false,
        kind: 'dirty',
        /*
         * By name. "You have unsaved changes in your project folder" is true and useless — it
         * sent people hunting through a repository for something they may never have edited
         * themselves, every time, with no way to tell which of it counted. Four names and a
         * count is a sentence you can act on.
         */
        reason:
          `You have unsaved changes to ${blocking.length === 1 ? 'a file' : `${blocking.length} files`} ` +
          `git is tracking: ${blocking.slice(0, 4).join(', ')}` +
          (blocking.length > 4 ? `, and ${blocking.length - 4} more` : '') +
          `. Merging on top of them would mix your work with the agent's, so nothing was ` +
          `touched. Commit them, or use "Set my work aside and merge".`,
        conflicts: blocking,
      }
    }
    try {
      // -u so untracked files come too; without it a new folder blocks the checkout anyway.
      await git(input.repo, ['stash', 'push', '-u', '-m', `vibePilot: before ${input.message}`])
      setAside = true
    } catch (e) {
      return {
        ok: false,
        kind: 'error',
        reason: `Could not set your changes aside: ${(e as Error).message.split('\n')[0]}`,
        conflicts: [],
      }
    }
  }

  /**
   * Put everything back exactly as it was: your branch, then your changes.
   *
   * The branch half was missing entirely — a *successful* merge left you standing on the base
   * branch instead of wherever you had been, which is a confusing thing to discover later and
   * a genuinely bad one if you then start editing.
   */
  const restore = async (): Promise<string | null> => {
    /*
     * Back where you were — unless where you were is a place the folder should never have been.
     *
     * Restoring the original branch is right, and it is also how a bad state got cemented: the
     * project folder was left standing on a ticket branch, so every merge dutifully put it back
     * there afterwards. The merge landed on the base branch, the folder went back to `vp/10`,
     * and the work was simultaneously merged and invisible — for days, with nothing on screen
     * able to reconcile those two facts.
     *
     * A ticket branch is never somewhere the main checkout belongs, so this is the one case
     * where "put it back" is the wrong instinct.
     */
    if (original !== input.baseBranch && !isTicketBranch(original)) {
      await git(input.repo, ['checkout', original]).catch(() => undefined)
    }
    if (!setAside) return null
    try {
      await git(input.repo, ['stash', 'pop'])
      return null
    } catch {
      // `pop` keeps the stash when it cannot apply cleanly, so nothing is lost — but the user
      // has to be told, in words they can act on.
      return (
        'Your changes could not be put back automatically — they are safe in git\'s stash. ' +
        'Run `git stash pop` in your project folder to deal with it.'
      )
    }
  }

  /*
   * Switching branches can fail on its own — most often because a file here would be
   * overwritten by the one on the base branch. That is a real collision and git names it
   * exactly; what it must not do is throw out of this function, which left the caller with a
   * rejected promise instead of an outcome it could report.
   */
  try {
    await git(input.repo, ['checkout', input.baseBranch])
  } catch (e) {
    const restoreNote = await restore()
    return {
      ok: false,
      kind: 'dirty',
      reason:
        `Could not switch to ${input.baseBranch}: ` +
        (e as Error).message.split(SPLIT).filter(Boolean).slice(-3).join(' ').trim(),
      conflicts: [],
      ...(restoreNote ? { restoreNote } : {}),
    }
  }

  try {
    await git(input.repo, ['merge', '--squash', input.branch])
  } catch (e) {
    let conflicts: string[] = []
    try {
      const out = await git(input.repo, ['diff', '--name-only', '--diff-filter=U'])
      conflicts = out.split('\n').map((s) => s.trim()).filter(Boolean)
    } catch {
      /* nothing more to learn */
    }
    // Leave the repo exactly as we found it. A half-merged working copy is worse than none.
    await git(input.repo, ['merge', '--abort']).catch(() => undefined)
    await undoMerge(input.repo, incoming)
    const restoreNote = await restore()
    return {
      ok: false,
      // Files git could not reconcile is the only thing that is genuinely a conflict.
      kind: conflicts.length > 0 ? 'conflict' : 'error',
      reason:
        (e as Error).message.split('\n')[0] ?? 'Merge failed.' + (restoreNote ? ` ${restoreNote}` : ''),
      conflicts,
    }
  }

  /*
   * The commit, which used to be unguarded — and that was the worst bug in this file.
   *
   * A throw here skipped everything below it, including `restore()`. So a merge that failed
   * after the user chose *"Set my work aside and merge"* left their work in git's stash and
   * said nothing: the branch was not put back, the stash was not popped, and what reached the
   * screen was a raw `Error invoking remote method 'git:merge'` from the IPC layer rejecting.
   * Nothing was destroyed, but nothing told them where it had gone either.
   *
   * It fired for a mundane reason. A branch whose work had already landed staged nothing, and
   * git refuses to make an empty commit — so the one case `hasLanded` now catches up front was
   * also the one case that hit the unguarded line.
   */
  /*
   * Asked structurally, not by reading git's prose. "nothing to commit" is a sentence git
   * writes to *stdout* in the user's own language — a regex over it is wrong on a German
   * machine and wrong again whenever the wording changes. An empty staged diff is the same
   * fact, in a form that cannot be mistranslated.
   */
  const staged = await git(input.repo, ['diff', '--cached', '--name-only']).catch(() => '')
  if (staged.trim().length === 0) {
    await undoMerge(input.repo, incoming)
    const restoreNote = await restore()
    return {
      ok: false,
      kind: 'empty',
      reason:
        `\`${input.branch}\` had nothing left to add — its work is already on ` +
        `${input.baseBranch}.` + (restoreNote ? ` ${restoreNote}` : ''),
      conflicts: [],
    }
  }

  try {
    await git(input.repo, ['commit', '-m', input.message])
  } catch (e) {
    // A hook, a signing key, a locked index — whatever it is, the merge did not land and the
    // user's working copy has to come back before anything else happens.
    await undoMerge(input.repo, incoming)
    const restoreNote = await restore()
    return {
      ok: false,
      kind: 'error',
      reason:
        `Could not record the merge: ` +
        `${(e as Error).message.split(SPLIT).filter(Boolean)[0] ?? 'git refused.'}` +
        (restoreNote ? ` ${restoreNote}` : ''),
      conflicts: [],
    }
  }

  const sha = await headSha(input.repo)
  const restoreNote = await restore()
  return { ok: true, sha, setAside, restoreNote }
}

/**
 * Put back only what the merge disturbed.
 *
 * This was `git reset --hard`, which restores *every* tracked file — including ones the user
 * edited that the merge never went near. The pre-flight only guarantees no overlap with the
 * incoming files; a change to anything else is deliberately allowed through, because merging
 * cannot harm it. Then a failure threw it away, to tidy up after an operation that had not
 * touched it.
 *
 * Naming the paths keeps the guarantee the pre-flight made. Without a file list there is
 * nothing to be surgical with, and `--hard` is the only way to leave a usable working copy —
 * still the right trade against a staged half-merge, but never the first choice.
 */
async function undoMerge(repo: string, incoming: string[] | null): Promise<void> {
  // Nothing came in, so there is nothing to take back out — and no excuse to touch anything.
  if (incoming !== null && incoming.length === 0) return
  if (incoming === null) {
    await git(repo, ['reset', '--hard']).catch(() => undefined)
    return
  }
  await git(repo, ['reset', '--', ...incoming]).catch(() => undefined)
  await git(repo, ['checkout', 'HEAD', '--', ...incoming]).catch(() => undefined)
}

/**
 * Commit anything vibePilot wrote inside the user's repository.
 *
 * Deliberately narrow. `git add` is given the one prefix and nothing else, so a bug here can
 * only ever commit the app's own bookkeeping — never a file the user was working on. If
 * nothing under that prefix has changed, or the folder is gitignored, this does nothing at all
 * and both arrangements work.
 */
export async function commitMachineOwned(repo: string): Promise<boolean> {
  try {
    const status = await git(repo, ['status', '--porcelain', '--', MACHINE_OWNED_PREFIX])
    if (status.trim().length === 0) return false

    await git(repo, ['add', '--', MACHINE_OWNED_PREFIX])

    // Re-check: `add` on an ignored path stages nothing, and committing then fails noisily.
    const staged = await git(repo, ['diff', '--cached', '--name-only', '--', MACHINE_OWNED_PREFIX])
    if (staged.trim().length === 0) return false

    await git(repo, [
      '-c',
      'user.name=vibePilot',
      '-c',
      'user.email=noreply@vibepilot.app',
      'commit',
      '-m',
      'vibepilot: memory update',
      '--only',
      '--',
      MACHINE_OWNED_PREFIX,
    ])
    return true
  } catch {
    // Never fail a merge over bookkeeping. If this cannot commit, the dirty check below will
    // say so in the ordinary way and the user is no worse off than before this existed.
    return false
  }
}
