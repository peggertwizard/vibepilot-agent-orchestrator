import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { BranchLine, BranchOverview, GhStatus, RemoteState } from '@shared/types'
import { git, unsavedChanges } from './repo'

const pExecFile = promisify(execFile)

/** `git rev-list --left-right --count a...b` → how far each side is from the other. */
export async function countAheadBehind(
  repo: string,
  a: string,
  b: string,
): Promise<{ ahead: number; behind: number }> {
  try {
    const out = await git(repo, ['rev-list', '--left-right', '--count', `${a}...${b}`])
    const [behind, ahead] = out.trim().split(/\s+/).map((n) => Number(n) || 0)
    return { ahead: ahead ?? 0, behind: behind ?? 0 }
  } catch {
    // An unborn branch, a missing ref, a repo mid-rebase. Zero is the honest answer: we do not
    // know of any commits, rather than claiming there are none.
    return { ahead: 0, behind: 0 }
  }
}

/**
 * How many commits a branch has that its base does not.
 *
 * This is the fact that decides whether finished work enters the merge queue. The commits
 * either exist or they do not — it is not a judgement call, and it must not be left to an
 * agent's self-declaration.
 */
export async function commitsAhead(repo: string, base: string, branch: string): Promise<number> {
  try {
    const out = await git(repo, ['rev-list', '--count', `${base}..${branch}`])
    return Number(out.trim()) || 0
  } catch {
    return 0
  }
}

export async function currentBranch(repo: string): Promise<string | null> {
  try {
    const out = (await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
    return out && out !== 'HEAD' ? out : null
  } catch {
    return null
  }
}

/** The upstream of a branch, if it has one. `origin` existing is not the same as tracking it. */
export async function upstreamOf(repo: string, branch: string): Promise<string | null> {
  try {
    return (
      await git(repo, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', `${branch}@{upstream}`])
    ).trim()
  } catch {
    return null
  }
}

export async function hasRemote(repo: string): Promise<boolean> {
  try {
    return (await git(repo, ['remote'])).trim().length > 0
  } catch {
    return false
  }
}

export async function overview(repo: string, base: string): Promise<BranchOverview> {
  const current = await currentBranch(repo)

  let remote: RemoteState | null = null
  if (await hasRemote(repo)) {
    const upstream = await upstreamOf(repo, base)
    // No upstream is still a remote: the base has simply never been pushed, which is exactly
    // the case where a Push button is most useful.
    remote = upstream
      ? { upstream, ...(await countAheadBehind(repo, upstream, base)) }
      : { upstream: null, ahead: await commitsAhead(repo, `${base}^`, base), behind: 0 }
  }

  let ticketBranches: BranchLine[] = []
  try {
    const out = await git(repo, ['branch', '--list', 'vp/*', '--format=%(refname:short)'])
    const names = out.split('\n').map((s) => s.trim()).filter(Boolean)
    ticketBranches = await Promise.all(
      names.map(async (name) => ({ name, ...(await countAheadBehind(repo, base, name)) })),
    )
  } catch {
    /* no branches yet, or not a repo — an empty list is the truth either way */
  }

  return {
    current,
    base,
    diverged: current !== null && current !== base,
    remote,
    ticketBranches,
    unsaved: await unsavedChanges(repo),
  }
}

/**
 * Push the base branch.
 *
 * The **base branch only**, never agent branches: the finished result leaves your machine and
 * the working copies never do. Pushing `vp/*` automatically would fill someone's remote with
 * branches they did not ask for and move code off the machine without a decision.
 *
 * It **refuses** when the base has diverged rather than offering `--force-with-lease`. This is
 * the one place in the app where being unhelpful is correct: the commits on the remote that you
 * do not have were put there by someone, and overwriting them is not a button.
 */
export async function pushBase(
  repo: string,
  base: string,
): Promise<{ ok: true; pushed: number } | { ok: false; reason: string }> {
  if (!(await hasRemote(repo))) {
    return { ok: false, reason: 'This repository has no remote, so there is nowhere to push.' }
  }

  const upstream = await upstreamOf(repo, base)
  if (upstream) {
    const { ahead, behind } = await countAheadBehind(repo, upstream, base)
    if (behind > 0) {
      return {
        ok: false,
        reason:
          `${upstream} has ${behind} commit${behind === 1 ? '' : 's'} you do not have. Pull ` +
          `and reconcile them yourself — vibePilot will not force a push over someone else's work.`,
      }
    }
    if (ahead === 0) return { ok: false, reason: `${upstream} is already up to date.` }
  }

  try {
    const ahead = upstream ? (await countAheadBehind(repo, upstream, base)).ahead : 0
    await git(repo, upstream ? ['push', 'origin', base] : ['push', '-u', 'origin', base], 120_000)
    return { ok: true, pushed: ahead }
  } catch (e) {
    return { ok: false, reason: (e as Error).message.split('\n').slice(0, 3).join(' ').trim() }
  }
}

/* ── GitHub, read-only and always optional ─────────────────────────────────── */

/**
 * Ask GitHub what it knows. Only when you press the button — never polled.
 *
 * Optional in every direction: no remote, no `gh`, not logged in, offline. Each of those makes
 * the section absent and changes nothing else, which is the property that keeps this from
 * quietly becoming a dependency of an app whose whole point is that it works locally.
 */
export async function githubStatus(repo: string): Promise<GhStatus> {
  const empty = { pullRequests: [], runs: [] }

  const gh = async (args: string[]): Promise<unknown> => {
    const { stdout } = await pExecFile('gh', args, {
      cwd: repo,
      windowsHide: true,
      shell: false,
      timeout: 20_000,
      maxBuffer: 4 * 1024 * 1024,
    })
    return JSON.parse(stdout || '[]')
  }

  try {
    const prs = (await gh([
      'pr',
      'list',
      '--limit',
      '10',
      '--json',
      'number,title,headRefName,state',
    ])) as Array<{ number: number; title: string; headRefName: string; state: string }>

    let runs: GhStatus['runs'] = []
    try {
      const raw = (await gh([
        'run',
        'list',
        '--limit',
        '5',
        '--json',
        'name,status,conclusion,headBranch',
      ])) as Array<{ name: string; status: string; conclusion: string; headBranch: string }>
      runs = raw.map((r) => ({
        name: r.name,
        status: r.status,
        conclusion: r.conclusion ?? '',
        branch: r.headBranch,
      }))
    } catch {
      // Actions may simply not be enabled on this repository. Pull requests are still useful.
    }

    return {
      available: true,
      pullRequests: prs.map((p) => ({
        number: p.number,
        title: p.title,
        branch: p.headRefName,
        state: p.state,
      })),
      runs,
    }
  } catch (e) {
    const msg = (e as Error).message
    return {
      available: false,
      reason: /ENOENT|not recognized|not found/i.test(msg)
        ? 'The GitHub CLI (`gh`) is not installed.'
        : /auth|login/i.test(msg)
          ? 'The GitHub CLI is not logged in. Run `gh auth login`.'
          : 'Could not reach GitHub.',
      ...empty,
    }
  }
}
