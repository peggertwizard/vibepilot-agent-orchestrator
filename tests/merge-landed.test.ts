import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { hasLanded, workingCopyState } from '../src/main/git/repo'
import { commitsAhead } from '../src/main/git/branches'
import { squashMerge } from '../src/main/git/worktree'

/**
 * Bookkeeping questions and content questions.
 *
 * Every bug covered here is one mistake wearing different clothes: git was asked something
 * about its own record-keeping when the only thing that mattered was whether any line of code
 * actually differed. Commits are bookkeeping. Line endings are bookkeeping.
 *
 * Real repositories throughout. The failures are in what git genuinely does with a
 * squash-merged branch and a file rewritten with different line endings, and a stub of git
 * would have agreed with the broken version exactly as readily as with the fixed one.
 */
describe('has this branch landed', () => {
  let repo: string

  const run = (...args: string[]): string =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true })

  const commit = (file: string, body: string): void => {
    writeFileSync(join(repo, file), body)
    run('add', '-A')
    run('-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '-m', `${file}`)
  }

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'vp-landed-'))
    run('init', '-b', 'main')
    commit('README.md', 'hello\n')
  })

  /**
   * The regression, pinned.
   *
   * `vp/2-silence-notesoverlay…` read as **three commits ahead** of `main` with **not one
   * line** missing from it. Everything downstream believed the count: the ticket stayed "ready
   * to merge", the emptiness guard never fired, and pressing the button re-ran a merge that
   * could only fail. A card that could not succeed and could not be dismissed.
   */
  it('is true after a squash merge, even though the commit count is not zero', async () => {
    run('checkout', '-b', 'vp/1-work')
    commit('feature.ts', 'export const x = 1\n')
    commit('feature2.ts', 'export const y = 2\n')
    run('checkout', 'main')

    const merged = await squashMerge({
      repo,
      branch: 'vp/1-work',
      baseBranch: 'main',
      message: 'vp(#1): work',
    })
    expect(merged.ok).toBe(true)

    // Squashing copies the changes across as one new commit; the originals stay on the branch.
    expect(await commitsAhead(repo, 'main', 'vp/1-work')).toBeGreaterThan(0)
    // And not one line of them is missing from main.
    expect(await hasLanded(repo, 'main', 'vp/1-work')).toBe(true)
  })

  it('is false while the branch still has work of its own', async () => {
    run('checkout', '-b', 'vp/1-work')
    commit('feature.ts', 'export const x = 1\n')
    run('checkout', 'main')
    expect(await hasLanded(repo, 'main', 'vp/1-work')).toBe(false)
  })

  /** Claiming work has landed is how work gets thrown away. A failed question is never grounds. */
  it('is false when the comparison itself fails', async () => {
    expect(await hasLanded(repo, 'main', 'no-such-branch')).toBe(false)
  })
})

describe('a merge that cannot be recorded', () => {
  let repo: string

  const run = (...args: string[]): string =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true })

  const commit = (file: string, body: string): void => {
    writeFileSync(join(repo, file), body)
    run('add', '-A')
    run('-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '-m', file)
  }

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'vp-recommit-'))
    run('init', '-b', 'main')
    commit('README.md', 'hello\n')
    run('checkout', '-b', 'vp/1-work')
    commit('feature.ts', 'export const x = 1\n')
    run('checkout', 'main')
  })

  /**
   * The commit was unguarded, and a throw there skipped `restore()` entirely.
   *
   * So a merge that failed after *"Set my work aside and merge"* left the user's work in git's
   * stash and said nothing — no branch put back, no stash popped, and a raw
   * `Error invoking remote method 'git:merge'` on screen from the IPC layer rejecting.
   */
  it('returns an outcome instead of throwing, and gives the work back', async () => {
    // Land it once, so the second attempt has nothing to stage and git refuses to commit.
    const first = await squashMerge({ repo, branch: 'vp/1-work', baseBranch: 'main', message: 'vp(#1)' })
    expect(first.ok).toBe(true)

    // Something of the user's, in a file the branch also touches, so it is genuinely set aside.
    writeFileSync(join(repo, 'feature.ts'), 'export const x = 1\n// mine\n')

    const again = await squashMerge({
      repo,
      branch: 'vp/1-work',
      baseBranch: 'main',
      message: 'vp(#1)',
      setAside: true,
    })

    expect(again.ok).toBe(false)
    if (again.ok) return
    expect(again.kind).toBe('empty')

    // The whole point: it came back.
    expect(readFileSync(join(repo, 'feature.ts'), 'utf8')).toContain('// mine')
    expect(run('stash', 'list').trim()).toBe('')
  })

  /**
   * The cleanup was `git reset --hard`, which restores every tracked file — including ones the
   * user edited that the merge never went near. The pre-flight deliberately lets those through
   * because merging cannot harm them; then a failure threw them away tidying up after an
   * operation that had not touched them.
   */
  it('leaves a file the merge never touched alone when it fails', async () => {
    commit('unrelated.ts', 'export const keep = true\n')

    // Make the branch conflict with main on its own file.
    run('checkout', 'vp/1-work')
    writeFileSync(join(repo, 'feature.ts'), 'export const x = 99\n')
    run('add', '-A')
    run('-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '-m', 'branch side')
    run('checkout', 'main')
    commit('feature.ts', 'export const x = 1000\n')

    // And something of the user's, in a file the branch does not touch at all.
    writeFileSync(join(repo, 'unrelated.ts'), 'export const keep = true\n// precious\n')

    const r = await squashMerge({ repo, branch: 'vp/1-work', baseBranch: 'main', message: 'vp(#1)' })
    expect(r.ok).toBe(false)

    expect(readFileSync(join(repo, 'unrelated.ts'), 'utf8')).toContain('// precious')
  })
})

describe('what counts as unsaved work', () => {
  let repo: string

  const run = (...args: string[]): string =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true })

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'vp-dirty-'))
    run('init', '-b', 'main')
    writeFileSync(join(repo, 'generated.ts'), 'export const a = 1\nexport const b = 2\n')
    run('add', '-A')
    run('-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '-m', 'init')
  })

  /**
   * `src/payload-types.ts`, exactly as it happened.
   *
   * A Docker container rewrote it with Linux line endings. `status --porcelain` decides
   * "modified" from mtime and size before it ever compares content, so it said yes — and the
   * panel put it in front of the user as unsaved work with a *Set my work aside and merge*
   * button, on every merge, on a file they had never opened. `git diff HEAD` on it printed
   * nothing. There was never anything there.
   */
  it('ignores a tracked file whose content did not actually change', async () => {
    run('config', 'core.autocrlf', 'false')
    const path = join(repo, 'generated.ts')
    // Rewrite with the other line ending, byte-for-byte the same content otherwise.
    writeFileSync(path, readFileSync(path, 'utf8').replace(/\n/g, '\r\n'))
    run('config', 'core.autocrlf', 'true')

    const status = run('status', '--porcelain')
    const seen = await workingCopyState(repo)

    // Only meaningful if git's own status did flag it — otherwise the test proves nothing.
    if (status.includes('generated.ts')) {
      expect(seen.map((e) => e.path)).not.toContain('generated.ts')
    }
  })

  it('still reports a tracked file that really did change', async () => {
    writeFileSync(join(repo, 'generated.ts'), 'export const a = 999\n')
    const seen = await workingCopyState(repo)
    expect(seen.map((e) => e.path)).toContain('generated.ts')
  })

  /** Only `status` knows about these, so the content check must never filter them out. */
  it('still reports untracked files', async () => {
    writeFileSync(join(repo, 'scratch.txt'), 'notes\n')
    const seen = await workingCopyState(repo)
    const entry = seen.find((e) => e.path === 'scratch.txt')
    expect(entry?.untracked).toBe(true)
  })
})
