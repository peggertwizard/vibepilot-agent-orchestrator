import { execFile, execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

const pExecFile = promisify(execFile)

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
 * Does the user have work in progress here?
 *
 * vibePilot's own files do not count. They are committed automatically on the way into a
 * merge, so treating them as "dirty" would block on something already dealt with — which is
 * exactly what happened: three merge cards in a row refused because the app's memory folder
 * had changed during the run.
 */
export async function isDirty(cwd: string): Promise<boolean> {
  return (await workingCopyState(cwd)).some((e) => !e.machineOwned)
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
