import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { git, headSha, isDirty } from './repo'
import { worktreeDir } from '../paths'

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
  | { ok: false; kind: 'dirty' | 'conflict' | 'error'; reason: string; conflicts: string[] }
> {
  const original = (await git(input.repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()

  /*
   * Your own unsaved work.
   *
   * Without `setAside` this stops and says so — merging on top of your changes would mix them
   * with the agent's. With it, vibePilot puts them safely to one side, merges, and puts them
   * straight back. Never automatic: quietly moving someone's uncommitted work is exactly the
   * thing that makes a tool feel unsafe, however reversible it is underneath.
   */
  let setAside = false
  if (await isDirty(input.repo)) {
    if (!input.setAside) {
      return {
        ok: false,
        kind: 'dirty',
        reason:
          'You have unsaved changes in your project folder. Merging on top of them would mix ' +
          'your work with the agent\'s, so nothing was touched.',
        conflicts: [],
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
    if (original !== input.baseBranch) {
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

  await git(input.repo, ['checkout', input.baseBranch])

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
    await git(input.repo, ['reset', '--hard']).catch(() => undefined)
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

  await git(input.repo, ['commit', '-m', input.message])
  const sha = await headSha(input.repo)
  const restoreNote = await restore()
  return { ok: true, sha, setAside, restoreNote }
}
