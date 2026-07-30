import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { GitError, git, refreshIndex, unchangedSinceHead, whatGitSaid } from '../src/main/git/repo'
import { squashMerge } from '../src/main/git/worktree'

/**
 * What git said, and what the app said it said.
 *
 * A finished, reviewed, green ticket failed to merge with `Command failed: git merge --squash
 * vp/3-...` and no reason at all. Git had explained itself perfectly — *"Your local changes to
 * the following files would be overwritten by merge: src/payload-types.ts"* — but that goes to
 * stderr, and every catch read `Error.message`, which for an `execFile` rejection is only the
 * command echoed back. With no reason on screen the app guessed, the Pilot guessed from the
 * app's guess, and the user was asked to stash a file they had never opened.
 *
 * Real repositories throughout: this is entirely about what git does with a stale index, and a
 * stub would have agreed with the broken version.
 */
describe('keeping git’s own words', () => {
  let repo: string
  const run = (...args: string[]): string =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true })

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'vp-giterr-'))
    run('init', '-q', '-b', 'main')
    writeFileSync(join(repo, 'a.txt'), 'one\n')
    run('add', '-A')
    run('-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '-qm', 'init')
  })

  it('throws a GitError carrying what git actually wrote', async () => {
    await expect(git(repo, ['checkout', 'no-such-branch'])).rejects.toBeInstanceOf(GitError)
    const e = (await git(repo, ['checkout', 'no-such-branch']).catch((x) => x)) as GitError
    expect(e.stderr).toMatch(/no-such-branch/)
    // The thing that was missing: a sentence a person can act on.
    expect(e.gitSaid).toMatch(/no-such-branch/)
    expect(e.gitSaid).not.toMatch(/^Command failed/)
  })

  it('whatGitSaid degrades to the message for anything that is not a GitError', () => {
    expect(whatGitSaid(new Error('something else'))).toBe('something else')
    expect(whatGitSaid(null)).toBe('git gave no reason.')
  })
})

/**
 * The phantom obstacle, reproduced exactly.
 *
 * A Docker container rewrites a generated file with identical bytes. Only the mtime changes.
 * Git's merge safety check reads the index's cached timestamp, decides the file may be modified,
 * and refuses. `git diff` compares content, finds nothing, and reports a clean tree. Both are
 * correct; the merge is what breaks.
 */
describe('a file that only looks modified', () => {
  let repo: string
  const run = (...args: string[]): string =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true })
  const commit = (m: string) => {
    run('add', '-A')
    run('-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '-qm', m)
  }

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'vp-phantom-'))
    run('init', '-q', '-b', 'main')
    writeFileSync(join(repo, 'generated.ts'), 'export const a = 1\n')
    commit('init')
    run('checkout', '-qb', 'vp/1-work')
    writeFileSync(join(repo, 'generated.ts'), 'export const a = 2\n')
    commit('branch changes the same file')
    run('checkout', '-q', 'main')
  })

  /** Rewriting with the same bytes is what the container does, and what git mistrusts. */
  const touchWithSameContent = (): void => {
    const p = join(repo, 'generated.ts')
    const body = readFileSync(p)
    writeFileSync(p, body)
    const future = new Date(Date.now() + 10_000)
    utimesSync(p, future, future)
  }

  it('is not a real change, and unchangedSinceHead says so', async () => {
    touchWithSameContent()
    expect(await unchangedSinceHead(repo, ['generated.ts'])).toBe(true)
  })

  it('merges anyway instead of refusing over a timestamp', async () => {
    touchWithSameContent()
    const r = await squashMerge({
      repo,
      branch: 'vp/1-work',
      baseBranch: 'main',
      message: 'vp(#1): work',
    })
    expect(r.ok, r.ok ? '' : `refused: ${r.reason}`).toBe(true)
    expect(readFileSync(join(repo, 'generated.ts'), 'utf8')).toContain('a = 2')
  })

  /** The guarantee that makes the retry safe: real work still stops the merge. */
  it('still refuses when the file genuinely differs, and says why', async () => {
    writeFileSync(join(repo, 'generated.ts'), 'export const a = 999 // mine\n')
    const r = await squashMerge({
      repo,
      branch: 'vp/1-work',
      baseBranch: 'main',
      message: 'vp(#1): work',
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toMatch(/generated\.ts|unsaved|overwritten/i)
    expect(r.reason).not.toMatch(/^Command failed/)
    // And the user's edit is exactly where they left it.
    expect(readFileSync(join(repo, 'generated.ts'), 'utf8')).toContain('mine')
  })

  it('refreshIndex leaves a genuinely modified file dirty', async () => {
    writeFileSync(join(repo, 'generated.ts'), 'export const a = 42\n')
    await refreshIndex(repo)
    expect(run('diff', '--name-only', 'HEAD').trim()).toBe('generated.ts')
  })
})
