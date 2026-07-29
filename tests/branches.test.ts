import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  commitsAhead,
  countAheadBehind,
  currentBranch,
  hasRemote,
  overview,
  pushBase,
} from '../src/main/git/branches'
import { squashMerge } from '../src/main/git/worktree'

/**
 * Where the work is, and whether it has landed.
 *
 * The whole point of reading this from local git is that it cannot fail when the network does —
 * vibePilot's own repository has no remote at all, so "degrades correctly without one" is not a
 * hypothetical case to design around, it is the common one.
 */
describe('branch overview', () => {
  let repo: string

  const run = (...args: string[]): string =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true })

  const commit = (file: string, body: string): void => {
    writeFileSync(join(repo, file), body)
    run('add', '-A')
    run('-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '-m', `add ${file}`)
  }

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'vp-branch-'))
    run('init', '-b', 'main')
    commit('README.md', 'hello')
  })

  it('reads the branch you are actually on', async () => {
    expect(await currentBranch(repo)).toBe('main')
    run('checkout', '-b', 'lead-desk')
    expect(await currentBranch(repo)).toBe('lead-desk')
    run('checkout', 'main')
  })

  it('marks divergence without following HEAD', async () => {
    run('checkout', '-b', 'somewhere-else')

    const ov = await overview(repo, 'main')

    expect(ov.current).toBe('somewhere-else')
    // The base is the stored setting. Following HEAD would silently retarget where every merge
    // lands the moment you check something else out — worse than the bug it would fix.
    expect(ov.base).toBe('main')
    expect(ov.diverged).toBe(true)

    run('checkout', 'main')
    expect((await overview(repo, 'main')).diverged).toBe(false)
  })

  it('counts the commits a branch has that its base does not', async () => {
    run('checkout', '-b', 'vp/2-fix-nav')
    commit('nav.ts', 'one')
    commit('nav2.ts', 'two')
    run('checkout', 'main')

    // This is the fact that decides whether finished work enters the merge queue. It is not a
    // judgement call and must not be left to an agent's self-declaration.
    expect(await commitsAhead(repo, 'main', 'vp/2-fix-nav')).toBe(2)

    const { ahead, behind } = await countAheadBehind(repo, 'main', 'vp/2-fix-nav')
    expect(ahead).toBe(2)
    expect(behind).toBe(0)
  })

  it('says a branch with no commits has nothing to merge', async () => {
    run('branch', 'vp/1-research-only')
    expect(await commitsAhead(repo, 'main', 'vp/1-research-only')).toBe(0)
  })

  it('lists agent branches and leaves everything else alone', async () => {
    const ov = await overview(repo, 'main')
    const names = ov.ticketBranches.map((b) => b.name).sort()

    expect(names).toEqual(['vp/1-research-only', 'vp/2-fix-nav'])
    // `somewhere-else` and `lead-desk` are yours, not an agent's.
    expect(names).not.toContain('somewhere-else')
  })

  it('has no remote section at all when there is no remote', async () => {
    expect(await hasRemote(repo)).toBe(false)
    expect((await overview(repo, 'main')).remote).toBeNull()
  })

  it('refuses to push when there is nowhere to push, rather than failing obscurely', async () => {
    const r = await pushBase(repo, 'main')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/no remote/i)
  })

  it('survives a ref that does not exist rather than throwing into the UI', async () => {
    expect(await commitsAhead(repo, 'main', 'nope')).toBe(0)
    expect(await countAheadBehind(repo, 'main', 'nope')).toEqual({ ahead: 0, behind: 0 })
  })
})

/**
 * Merging, when your own folder is not tidy.
 *
 * The old path did two unkind things: it refused with a message written for someone who knows
 * what "uncommitted changes" means, and on the way *out* of a successful merge it never checked
 * you back onto the branch you had been standing on.
 */
describe('merging around your own unsaved work', () => {
  let repo: string

  const run = (...args: string[]): string =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true })

  const commit = (file: string, body: string): void => {
    writeFileSync(join(repo, file), body)
    run('add', '-A')
    run('-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '-m', `add ${file}`)
  }

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'vp-merge-'))
    run('init', '-b', 'main')
    commit('README.md', 'hello')
    run('checkout', '-b', 'vp/9-work')
    commit('feature.ts', 'export const x = 1')
    run('checkout', '-b', 'my-branch', 'main')
  })

  it('leaves you on the branch you were standing on', async () => {
    expect(await currentBranch(repo)).toBe('my-branch')

    const r = await squashMerge({
      repo,
      branch: 'vp/9-work',
      baseBranch: 'main',
      message: 'vp(#9): the work',
    })

    expect(r.ok).toBe(true)
    // A successful merge used to dump you on `main` and say nothing about it.
    expect(await currentBranch(repo)).toBe('my-branch')
    expect(await commitsAhead(repo, 'my-branch', 'main')).toBe(1)
  })

  it('refuses in plain words when you have unsaved work, and touches nothing', async () => {
    run('checkout', '-b', 'vp/10-more', 'main')
    commit('another.ts', 'export const y = 2')
    run('checkout', 'my-branch')
    writeFileSync(join(repo, 'notes.md'), 'half-written thought')

    const before = await commitsAhead(repo, 'my-branch', 'main')
    const r = await squashMerge({
      repo,
      branch: 'vp/10-more',
      baseBranch: 'main',
      message: 'vp(#10): more',
    })

    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    // Not a conflict. Nothing about the branch is wrong.
    expect(r.kind).toBe('dirty')
    expect(r.conflicts).toEqual([])
    expect(r.reason, 'no jargon').toMatch(/unsaved changes in your project folder/i)
    expect(await commitsAhead(repo, 'my-branch', 'main'), 'nothing was merged').toBe(before)
    expect(await currentBranch(repo)).toBe('my-branch')
  })

  it('sets your work aside, merges, and gives it straight back', async () => {
    expect(readFileSync(join(repo, 'notes.md'), 'utf8')).toBe('half-written thought')

    const r = await squashMerge({
      repo,
      branch: 'vp/10-more',
      baseBranch: 'main',
      message: 'vp(#10): more',
      setAside: true,
    })

    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error('unreachable')
    expect(r.setAside).toBe(true)
    expect(r.restoreNote, 'it came back cleanly, so nothing to warn about').toBeNull()

    // The work landed…
    expect(await commitsAhead(repo, 'my-branch', 'main')).toBe(2)
    // …you are where you were…
    expect(await currentBranch(repo)).toBe('my-branch')
    // …and your half-written thought is exactly where you left it.
    expect(readFileSync(join(repo, 'notes.md'), 'utf8')).toBe('half-written thought')
  })

  it('brings untracked files back too, not just edits', async () => {
    run('checkout', '-b', 'vp/11-third', 'main')
    commit('third.ts', 'export const z = 3')
    run('checkout', 'my-branch')

    // Created only now: the `commit` helper stages with `add -A`, so anything lying around
    // before it would have been swept into the branch rather than left untracked.
    mkdirSync(join(repo, 'scratch'), { recursive: true })
    writeFileSync(join(repo, 'scratch', 'idea.txt'), 'do not lose me')

    const r = await squashMerge({
      repo,
      branch: 'vp/11-third',
      baseBranch: 'main',
      message: 'vp(#11): third',
      setAside: true,
    })

    expect(r.ok).toBe(true)
    expect(readFileSync(join(repo, 'scratch', 'idea.txt'), 'utf8')).toBe('do not lose me')
  })
})
