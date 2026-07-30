import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { squashMerge, syncWithBase } from '../src/main/git/worktree'

/**
 * The staleness that produced every conflict.
 *
 * Reproduced from the real failure: four ticket branches, each 9 to 12 commits behind the
 * base, all four editing the same three files, every one of them conflicting on merge. Nothing
 * was wrong with any of them — they had simply been cut from the base and left there while it
 * moved on, because nothing in the app ever brought the base back.
 *
 * These tests are deliberately built on real repositories rather than mocks. The bug was in
 * what git actually does with a stale branch, and a stub of git would have agreed with the
 * broken version just as readily as with the fixed one.
 */
describe('keeping a branch level with the base', () => {
  let repo: string
  let worktree: string

  const run = (cwd: string, ...args: string[]): string =>
    execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })

  const commit = (cwd: string, file: string, body: string): void => {
    writeFileSync(join(cwd, file), body)
    run(cwd, 'add', '-A')
    run(cwd, '-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '-m', `${file}: ${body.slice(0, 20)}`)
  }

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'vp-sync-'))
    worktree = join(mkdtempSync(join(tmpdir(), 'vp-sync-wt-')), 'wt')
    run(repo, 'init', '-b', 'main')
    commit(repo, 'prices.ts', 'a\nb\nc\n')
    run(repo, 'branch', 'vp/1-work')
    run(repo, 'worktree', 'add', worktree, 'vp/1-work')
  })

  const sync = (): ReturnType<typeof syncWithBase> =>
    syncWithBase({ repo, worktree, branch: 'vp/1-work', baseBranch: 'main' })

  it('does nothing when the branch is already level', async () => {
    const r = await sync()
    expect(r).toEqual({ ok: true, behind: 0, conflicts: [] })
  })

  it('brings the base in when the branch has fallen behind', async () => {
    commit(repo, 'other.ts', 'landed elsewhere\n')
    commit(repo, 'again.ts', 'and again\n')

    const r = await sync()
    expect(r.ok).toBe(true)
    expect(r.behind).toBe(2)

    // Level now: nothing on main that the branch does not have.
    expect(run(repo, 'rev-list', '--count', 'vp/1-work..main').trim()).toBe('0')
  })

  it('keeps the branch its own work while catching up', async () => {
    commit(worktree, 'mine.ts', 'the agent wrote this\n')
    commit(repo, 'other.ts', 'landed elsewhere\n')

    expect((await sync()).ok).toBe(true)
    expect(run(repo, 'rev-list', '--count', 'main..vp/1-work').trim()).not.toBe('0')
    expect(run(worktree, 'show', 'HEAD:mine.ts')).toContain('the agent wrote this')
    expect(run(worktree, 'show', 'HEAD:other.ts')).toContain('landed elsewhere')
  })

  /**
   * The heartbeat runs this every few minutes on every open ticket. Catching up twice must be
   * free — a merge that re-applied what it already had would churn the branch for ever and
   * hand every agent a fresh diff each tick.
   */
  it('is a no-op the second time', async () => {
    commit(repo, 'other.ts', 'landed elsewhere\n')
    await sync()
    const head = run(worktree, 'rev-parse', 'HEAD').trim()

    const again = await sync()
    expect(again.behind).toBe(0)
    expect(run(worktree, 'rev-parse', 'HEAD').trim()).toBe(head)
  })

  it('reports a real disagreement without leaving the worktree mid-merge', async () => {
    commit(worktree, 'prices.ts', 'a\nMINE\nc\n')
    commit(repo, 'prices.ts', 'a\nTHEIRS\nc\n')

    const r = await sync()
    expect(r.ok).toBe(false)
    expect(r.behind).toBe(1)
    expect(r.conflicts).toEqual(['prices.ts'])

    // Aborted, not abandoned halfway: the agent can still commit in here.
    expect(run(worktree, 'status', '--porcelain').trim()).toBe('')
    expect(run(worktree, 'show', 'HEAD:prices.ts')).toContain('MINE')
  })

  /**
   * The point of the whole exercise: after syncing, the merge into the base cannot conflict.
   * This is the case that used to fail — and it failed in the *user's own project folder*.
   */
  it('makes the merge that follows it clean', async () => {
    commit(worktree, 'prices.ts', 'a\nb\nc\nMINE\n')
    commit(repo, 'prices.ts', 'THEIRS\na\nb\nc\n')

    expect((await sync()).ok).toBe(true)

    const merged = await squashMerge({
      repo,
      branch: 'vp/1-work',
      baseBranch: 'main',
      message: 'vp(#1): work',
    })
    expect(merged.ok).toBe(true)
    const file = run(repo, 'show', 'main:prices.ts')
    expect(file).toContain('MINE')
    expect(file).toContain('THEIRS')
  })

  it('says so rather than throwing when there is no working copy to update in', async () => {
    commit(repo, 'other.ts', 'landed elsewhere\n')
    const r = await syncWithBase({
      repo,
      worktree: join(repo, 'no-such-worktree'),
      branch: 'vp/1-work',
      baseBranch: 'main',
    })
    expect(r.ok).toBe(false)
    expect(r.behind).toBe(1)
    expect(r.conflicts).toEqual([])
  })

  it('treats an unmeasurable gap as no gap', async () => {
    const r = await syncWithBase({ repo, worktree, branch: 'vp/1-work', baseBranch: 'no-such-base' })
    expect(r).toEqual({ ok: true, behind: 0, conflicts: [] })
  })
})
