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
import { isTicketBranch, squashMerge } from '../src/main/git/worktree'

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

  /*
   * A scratch file is not "unsaved work".
   *
   * The guard refused any merge into a tree git reported as anything other than spotless, which
   * swept in every untracked file: a build artefact, a folder some tool dropped in, a
   * half-written note. `WorkingCopyEntry.untracked` has documented the distinction since it was
   * added and the Branches tab has always shown it — the merge guard was the one place that
   * ignored it, and it is the only place that could stop you.
   */
  it('merges past an untracked file, and leaves it alone', async () => {
    run('checkout', '-b', 'vp/10-more', 'main')
    commit('another.ts', 'export const y = 2')
    run('checkout', 'my-branch')
    writeFileSync(join(repo, 'notes.md'), 'half-written thought')

    const r = await squashMerge({
      repo,
      branch: 'vp/10-more',
      baseBranch: 'main',
      message: 'vp(#10): more',
    })

    expect(r.ok).toBe(true)
    expect(await currentBranch(repo)).toBe('my-branch')
    // Untouched, and still untracked.
    expect(readFileSync(join(repo, 'notes.md'), 'utf8')).toBe('half-written thought')
  })

  /*
   * The `importMap.js` case, which is the one that actually kept happening.
   *
   * Some frameworks rewrite a *tracked* file every time the app runs — a generated import map,
   * a build stamp, a lockfile. The tree is therefore permanently dirty, and the old guard
   * refused every merge in that project for ever on the strength of it, with a message naming
   * nothing. But if the incoming branch does not touch that file, merging cannot harm it: git
   * leaves the working-tree change exactly where it is.
   *
   * *"why can't you find a way to merge it and keep all the files?"* — you can.
   */
  it('merges past a modified file the branch does not touch', async () => {
    run('checkout', '-b', 'vp/11-elsewhere', 'main')
    commit('elsewhere.ts', 'export const z = 3')
    run('checkout', 'my-branch')
    writeFileSync(join(repo, 'README.md'), 'regenerated by the dev server')

    const r = await squashMerge({
      repo,
      branch: 'vp/11-elsewhere',
      baseBranch: 'main',
      message: 'vp(#11): elsewhere',
    })

    expect(r.ok).toBe(true)
    expect(await currentBranch(repo)).toBe('my-branch')
    // The whole point: your edit survived the merge, uncommitted, exactly as you left it.
    expect(readFileSync(join(repo, 'README.md'), 'utf8')).toBe('regenerated by the dev server')
  })

  /*
   * And it still stops when the two genuinely overlap — with the filename, because "you have
   * unsaved changes in your project folder" sent people hunting through a repository for
   * something they may never have edited themselves.
   */
  it('refuses by name when your change and the branch touch the same file', async () => {
    run('-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '-am', 'keep the readme edit')
    run('checkout', '-b', 'vp/12-same', 'main')
    commit('shared.ts', 'export const a = 1')
    run('checkout', 'my-branch')
    writeFileSync(join(repo, 'shared.ts'), 'export const a = 999')
    run('add', 'shared.ts')

    const before = await commitsAhead(repo, 'my-branch', 'main')
    const r = await squashMerge({
      repo,
      branch: 'vp/12-same',
      baseBranch: 'main',
      message: 'vp(#12): same file',
    })

    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    // Not a conflict. Nothing about the branch is wrong.
    expect(r.kind).toBe('dirty')
    expect(r.reason, 'names the file').toMatch(/shared\.ts/)
    expect(r.conflicts).toContain('shared.ts')
    expect(await commitsAhead(repo, 'my-branch', 'main'), 'nothing was merged').toBe(before)
    expect(await currentBranch(repo)).toBe('my-branch')
  })

  it('sets that work aside, merges, and gives it straight back', async () => {
    const r = await squashMerge({
      repo,
      branch: 'vp/12-same',
      baseBranch: 'main',
      message: 'vp(#12): same file',
      setAside: true,
    })

    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error('unreachable')
    expect(r.setAside).toBe(true)
    expect(r.restoreNote, 'it came back cleanly, so nothing to warn about').toBeNull()
    expect(await currentBranch(repo)).toBe('my-branch')
    // Your edit is exactly where you left it.
    expect(readFileSync(join(repo, 'shared.ts'), 'utf8')).toBe('export const a = 999')

    // Put the tree back for the next case. `shared.ts` only exists on the branch that was just
    // merged into main, so there is nothing on `my-branch` to restore it from — reset the index
    // and sweep. A staged file left behind blocks the next `checkout -b`, which is git's own
    // guard and nothing to do with what is under test here.
    run('reset', '--hard')
    run('clean', '-fd')
  })

  it('brings untracked files back when it does set work aside', async () => {
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


/**
 * The project folder is not a place a ticket branch may live.
 *
 * It happened, and it cost days: the main checkout was left standing on `vp/10`, every merge
 * afterwards dutifully put it back there, and the result was work that was merged *and*
 * invisible at the same time — both true, with nothing on screen able to reconcile them. A
 * dev server bind-mounting that folder showed the wrong branch the whole time.
 *
 * Restoring the branch you were on is right in general. This is the one case where it is not.
 */
describe('what a merge leaves the folder standing on', () => {
  let repo: string
  const run = (...args: string[]): string =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true })
  const commit = (file: string, body: string): void => {
    writeFileSync(join(repo, file), body)
    run('add', '-A')
    run('-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '-m', `add ${file}`)
  }

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'vp-restore-'))
    run('init', '-b', 'main')
    commit('README.md', 'hello')
  })

  it('knows which branches it made itself', () => {
    expect(isTicketBranch('vp/10-install-agent-rules')).toBe(true)
    expect(isTicketBranch('vp/1-x')).toBe(true)
    // Near misses on purpose: a prefix check that is too eager would move a user's own branch.
    expect(isTicketBranch('vp/experiment')).toBe(false)
    expect(isTicketBranch('feature/vp/2-thing')).toBe(false)
    expect(isTicketBranch('main')).toBe(false)
    expect(isTicketBranch(null)).toBe(false)
  })

  it('does not put the folder back on a ticket branch', async () => {
    run('checkout', '-b', 'vp/7-work', 'main')
    commit('seven.ts', 'export const s = 7')
    // The bad state: the main checkout standing where only a worktree should.
    run('checkout', 'vp/7-work')

    run('checkout', '-b', 'vp/8-other', 'main')
    commit('eight.ts', 'export const e = 8')
    run('checkout', 'vp/7-work')

    const r = await squashMerge({
      repo,
      branch: 'vp/8-other',
      baseBranch: 'main',
      message: 'vp(#8): other',
    })

    expect(r.ok).toBe(true)
    // Not back on vp/7 — that is what cemented the problem every single time.
    expect(await currentBranch(repo)).toBe('main')
  })

  it('still puts you back on a branch of your own', async () => {
    run('checkout', '-b', 'my-own-thing', 'main')
    run('checkout', '-b', 'vp/9-more', 'main')
    commit('nine.ts', 'export const n = 9')
    run('checkout', 'my-own-thing')

    const r = await squashMerge({
      repo,
      branch: 'vp/9-more',
      baseBranch: 'main',
      message: 'vp(#9): more',
    })

    expect(r.ok).toBe(true)
    // Yours. Moving it without being asked is the opposite mistake.
    expect(await currentBranch(repo)).toBe('my-own-thing')
  })
})
