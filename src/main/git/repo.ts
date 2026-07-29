import { execFile } from 'node:child_process'
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

export async function isDirty(cwd: string): Promise<boolean> {
  const out = await git(cwd, ['status', '--porcelain'])
  return out.trim().length > 0
}

/**
 * What is sitting unsaved in the project folder, by name.
 *
 * Read *before* the merge button is pressed, so the card can say what is in the way rather than
 * letting you press a button that was never going to work and then explaining. Names, not a
 * count: "five things" is a shrug, and `.claude/skills/cron/` is something you recognise.
 */
export async function unsavedChanges(cwd: string): Promise<string[]> {
  try {
    const out = await git(cwd, ['status', '--porcelain'])
    return out
      .split(/\r?\n/)
      .map((l) => l.slice(3).trim())
      .filter(Boolean)
      .slice(0, 40)
  } catch {
    return []
  }
}

export async function headSha(cwd: string): Promise<string> {
  return (await git(cwd, ['rev-parse', 'HEAD'])).trim()
}
