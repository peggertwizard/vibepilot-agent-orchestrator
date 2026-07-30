import { execFile, execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

const pExecFile = promisify(execFile)

/** CRLF or LF — git's output depends on the platform and the config. */
const SPLIT_LINES = new RegExp('\r?\n')

/** Always shell:false — repo paths and branch names are untrusted input. */
export async function git(cwd: string, args: string[], timeout = 60_000): Promise<string> {
  const { stdout } = await pExecFile('git', args, {
    cwd,
    windowsHide: true,
    shell: false,
    timeout,
    maxBuffer: 32 * 1024 * 1024,
  })
  return stdout
}

export async function gitVersion(): Promise<string | null> {
  try {
    const { stdout } = await pExecFile('git', ['--version'], { windowsHide: true, shell: false })
    return stdout.trim()
  } catch {
    return null
  }
}

/** The GitHub CLI, if installed. Optional everywhere — never a dependency. */
export async function ghVersion(): Promise<string | null> {
  try {
    const { stdout } = await pExecFile('gh', ['--version'], {
      windowsHide: true,
      shell: false,
      timeout: 8000,
    })
    return stdout.split(/\r?\n/)[0]?.trim() ?? null
  } catch {
    return null
  }
}

export interface RepoInfo {
  isRepo: boolean
  root: string | null
  remote: string | null
  currentBranch: string | null
  defaultBranch: string | null
  longPathsEnabled: boolean
}

export async function detectGitRepo(path: string): Promise<RepoInfo> {
  const empty: RepoInfo = {
    isRepo: false,
    root: null,
    remote: null,
    currentBranch: null,
    defaultBranch: null,
    longPathsEnabled: false,
  }
  if (!existsSync(join(path, '.git'))) {
    // Could still be a subdirectory of a repo.
    try {
      await git(path, ['rev-parse', '--git-dir'])
    } catch {
      return empty
    }
  }

  try {
    const root = (await git(path, ['rev-parse', '--show-toplevel'])).trim()
    const currentBranch = (await git(path, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
    let remote: string | null = null
    try {
      remote = (await git(path, ['remote', 'get-url', 'origin'])).trim() || null
    } catch {
      /* no origin — perfectly fine for a local-only project */
    }
    const defaultBranch = await detectDefaultBranch(path, currentBranch)
    let longPathsEnabled = false
    try {
      longPathsEnabled = (await git(path, ['config', '--get', 'core.longpaths'])).trim() === 'true'
    } catch {
      /* unset */
    }
    return { isRepo: true, root, remote, currentBranch, defaultBranch, longPathsEnabled }
  } catch {
    return empty
  }
}

async function detectDefaultBranch(path: string, fallback: string): Promise<string> {
  // origin/HEAD is authoritative when a remote exists.
  try {
    const ref = (await git(path, ['symbolic-ref', 'refs/remotes/origin/HEAD'])).trim()
    const name = ref.split('/').pop()
    if (name) return name
  } catch {
    /* no remote HEAD */
  }
  for (const candidate of ['main', 'master']) {
    try {
      await git(path, ['rev-parse', '--verify', candidate])
      return candidate
    } catch {
      /* try next */
    }
  }
  return fallback || 'main'
}

/**
 * Changes that genuinely stand in the way of a merge.
 *
 * Two exclusions, and both of them were already written down before anything honoured them:
 *
 *   - **vibePilot's own files.** Committed automatically on the way into a merge, so counting
 *     them as dirty blocks on something already dealt with.
 *   - **untracked files.** `WorkingCopyEntry.untracked` has documented since it was added that
 *     these are "not equally in the way", and the Branches tab has always listed them
 *     separately — but `isDirty`, the thing that actually refuses the merge, used
 *     `!machineOwned` and counted them anyway. So one stray build artefact, a Docker volume, a
 *     folder some tool dropped in, blocked *every* merge in that project, for ever, with a
 *     message about "your unsaved work" naming nothing.
 *
 * Dropping them is safe because git already guards this precisely: `checkout` and
 * `merge --squash` both refuse when they would overwrite an untracked file, and both name it.
 * This check exists to give a kinder message than git's, not to be the safety net.
 */
export async function blockingChanges(cwd: string, incoming?: string[]): Promise<string[]> {
  const mine = (await modifiedFiles(cwd)).filter((p) => !isMachineOwned(p))

  /*
   * And of those, only the ones the incoming work actually touches.
   *
   * This is the part that turned a correct caution into a permanent block. The guard asked
   * *"is the tree dirty?"* when the only question that matters is *"do my changes overlap with
   * what is being merged?"* — and for a generated file that the app rewrites every time it
   * runs (`importMap.js`, a build stamp, a lockfile), the answer to the first is always yes and
   * the answer to the second is almost always no.
   *
   * With no overlap the merge is completely safe and the working-tree change survives it
   * untouched, which is exactly what the user asked for: *"why can't you find a way to merge it
   * and keep all the files?"* You can. Git does it by default.
   *
   * Called without `incoming` this stays conservative and reports everything — that is the
   * pre-flight the Branches tab uses before a branch is even chosen.
   */
  if (!incoming) return mine
  const touched = new Set(incoming.map(norm))
  return mine.filter((p) => touched.has(norm(p)))
}

/**
 * Tracked files whose **content** differs from HEAD.
 *
 * Not `git status --porcelain`, which is what this used and which lies in a way that costs a
 * whole afternoon. Status decides a file is "modified" from its mtime and size and only then
 * compares content — so a file a container rewrote byte-for-byte, or one whose line endings
 * were normalised on checkout, is reported as changed while `git diff` finds nothing in it at
 * all. That is exactly what happened to a generated `importMap.js`: it blocked a merge, the
 * user was asked whether to stash or commit it, and the real diff was empty. There was never
 * anything there.
 *
 * `diff --name-only HEAD` compares content, staged and unstaged together, and is therefore the
 * only honest answer to "would merging disturb something of mine".
 */
async function modifiedFiles(cwd: string): Promise<string[]> {
  try {
    const out = await git(cwd, ['diff', '--name-only', 'HEAD'])
    return out.split(SPLIT_LINES).map((l) => l.trim()).filter(Boolean)
  } catch {
    // No HEAD yet (a repo with no commits) — nothing can be in the way of a merge either.
    return []
  }
}

/** Git speaks forward slashes; Windows does not always. Compare on one of them. */
function norm(p: string): string {
  return p.replace(/\\/g, '/').replace(/^"|"$/g, '')
}

/**
 * The files a branch would bring in, against the base it would land on.
 *
 * Three dots: what `branch` changed *since it forked*, not everything that differs between the
 * two. Two dots would count files the base moved on independently, which is precisely the set
 * that does not conflict.
 */
export async function incomingFiles(
  cwd: string,
  baseBranch: string,
  branch: string,
): Promise<string[] | null> {
  try {
    const out = await git(cwd, ['diff', '--name-only', `${baseBranch}...${branch}`])
    return out
      .split(SPLIT_LINES)
      .map((l) => l.trim())
      .filter(Boolean)
  } catch {
    // Cannot tell what is coming — so do not claim that nothing is. The caller falls back to
    // treating every tracked change as blocking, which is the old, safe, annoying behaviour.
    return null
  }
}

/** @deprecated Prefer `blockingChanges` — the names are what makes the refusal actionable. */
export async function isDirty(cwd: string): Promise<boolean> {
  return (await blockingChanges(cwd)).length > 0
}

/**
 * What is sitting unsaved in the project folder, by name.
 *
 * Read *before* the merge button is pressed, so the card can say what is in the way rather than
 * letting you press a button that was never going to work and then explaining. Names, not a
 * count: "five things" is a shrug, and `.claude/skills/cron/` is something you recognise.
 */
export async function unsavedChanges(cwd: string): Promise<string[]> {
  return (await workingCopyState(cwd)).map((e) => e.path)
}

/**
 * vibePilot's own bookkeeping, inside the user's repository.
 *
 * `remember` and the curator write here continuously during a run. If the folder is committed
 * — which is a perfectly reasonable thing to want, since memory that survives a fresh clone is
 * worth having — then every single memory write dirties the working tree, and the merge guard
 * counts it as *the user's* unsaved work.
 *
 * The result was a merge that could never happen: finish a ticket, press Merge, be told you
 * have unsaved changes, discover the changes are the app's own diary. The Pilot ended up
 * hand-committing this folder before every merge and apologising for it, which is the clearest
 * possible sign that the machinery was wrong rather than the user.
 */
export const MACHINE_OWNED_PREFIX = '.vibepilot/'

/** Is this path vibePilot's own, rather than the user's work? */
export function isMachineOwned(path: string): boolean {
  return path.replace(/\\/g, '/').startsWith(MACHINE_OWNED_PREFIX)
}

export interface WorkingCopyEntry {
  path: string
  /**
   * Untracked, as opposed to a change to a file git already knows about.
   *
   * Worth separating, because the two are not equally in the way. A modified tracked file
   * genuinely conflicts with a merge. An untracked one — a tool that dropped `.claude/skills/`
   * into the folder, a scratch file, a build artefact nobody has ignored yet — collides only
   * if the incoming work happens to add the same path, which it usually does not.
   *
   * Reporting both as "unsaved work" meant a merge button that said it was blocked by four
   * folders the user had never edited and did not consider theirs.
   */
  untracked: boolean
  /**
   * Written by vibePilot, not by the user.
   *
   * A third category, because it needs a third behaviour: not "in the way" like a modified
   * tracked file, and not "leave it alone" like an untracked one. It gets committed on the
   * way past.
   */
  machineOwned: boolean
}

/** What is in the working copy, and whether git was already tracking it. */
export async function workingCopyState(cwd: string): Promise<WorkingCopyEntry[]> {
  try {
    const out = await git(cwd, ['status', '--porcelain'])
    return out
      .split(/\r?\n/)
      .filter((l) => l.trim().length > 0)
      .slice(0, 60)
      .map((l) => {
        const path = l.slice(3).trim()
        return {
          // `??` is git's marker for untracked. Everything else is a change to something known.
          untracked: l.startsWith('??'),
          machineOwned: isMachineOwned(path),
          path,
        }
      })
      .filter((e) => e.path.length > 0)
  } catch {
    return []
  }
}

export async function headSha(cwd: string): Promise<string> {
  return (await git(cwd, ['rev-parse', 'HEAD'])).trim()
}

/**
 * Is this path on another machine?
 *
 * A UNC path (`\\host\share\...`) or a mapped network drive. vibePilot works on one — every
 * path downstream is an ordinary `fs` or `execFile` call that does not care what is behind
 * it — but git over a network mount is slow in a way that shows up as tickets taking longer
 * for no visible reason.
 *
 * Detected so the app can say so at the moment the folder is chosen. Accepting it silently
 * and letting the slowness be discovered through a mysterious ticket is the same shape of
 * problem as a board that reports finished work as in progress.
 *
 * See `docs/architecture/remote-projects.md` and `scripts/spikes/remote-path.mjs`.
 */
export function isNetworkPath(path: string): boolean {
  const p = path.replace(/\//g, '\\')
  if (p.startsWith('\\\\')) return true

  // A mapped drive. `net use` is the only reliable way to tell one from a local disk, and it
  // is cheap — but it exists only on Windows, so a failure here means "not mapped".
  const drive = /^([A-Za-z]):/.exec(p)?.[1]
  if (!drive || process.platform !== 'win32') return false
  try {
    const out = execFileSync('net', ['use', `${drive}:`], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return out.length > 0
  } catch {
    return false
  }
}
