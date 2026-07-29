import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { isDirty, isMachineOwned, workingCopyState } from '../src/main/git/repo'
import { commitMachineOwned, squashMerge } from '../src/main/git/worktree'

/**
 * vibePilot's own files must never block a merge.
 *
 * The failure this fixes, from a real session: three finished tickets, three merge buttons,
 * and every one of them refusing with *"you have unsaved changes in your project folder"*. The
 * changes were `.vibepilot/memory/project/decisions.md` and `.vibepilot/memory/agents/` —
 * written by the app itself during the run. The Pilot took to hand-committing the folder before
 * each merge and apologising for it, which is a bug report in the shape of an apology.
 */

let repo: string

const gitq = (args: string[], cwd = repo): string =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  })

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'vp-mo-'))
  gitq(['init', '-q', '-b', 'main'])
  writeFileSync(join(repo, 'app.js'), 'export const a = 1\n')
  gitq(['add', '-A'])
  gitq(['commit', '-qm', 'initial'])
})

/** Write something the way `remember` and the curator do — inside the repo. */
function writeMemory(body = 'a decision\n'): void {
  mkdirSync(join(repo, '.vibepilot', 'memory', 'project'), { recursive: true })
  writeFileSync(join(repo, '.vibepilot', 'memory', 'project', 'decisions.md'), body)
}

describe('what counts as vibePilot’s own', () => {
  it('recognises the memory folder, on either slash', () => {
    expect(isMachineOwned('.vibepilot/memory/project/decisions.md')).toBe(true)
    expect(isMachineOwned('.vibepilot\\memory\\agents\\robin.md')).toBe(true)
  })

  it('does not claim anything else', () => {
    // Near misses on purpose — a prefix check that is too eager would commit user files.
    expect(isMachineOwned('src/vibepilot/thing.ts')).toBe(false)
    expect(isMachineOwned('.vibepilot-notes.md')).toBe(false)
    expect(isMachineOwned('app.js')).toBe(false)
  })
})

describe('the working copy, classified', () => {
  it('marks the app’s files machine-owned and the user’s not', async () => {
    writeMemory()
    writeFileSync(join(repo, 'app.js'), 'export const a = 2\n')

    const state = await workingCopyState(repo)
    /*
     * Matched by prefix rather than by filename, because git collapses a wholly-new directory
     * to `?? .vibepilot/` and only names individual files once the folder is tracked. Both
     * shapes have to classify the same way, which is exactly why the check is a prefix.
     */
    const mine = state.find((e) => e.path.startsWith('.vibepilot'))
    const theirs = state.find((e) => e.path === 'app.js')

    expect(mine).toBeDefined()
    expect(mine?.machineOwned).toBe(true)
    expect(theirs?.machineOwned).toBe(false)
  })

  /** The assertion the whole change exists for. */
  it('is NOT dirty when only vibePilot has written', async () => {
    writeMemory()
    expect(await isDirty(repo)).toBe(false)
  })

  it('is still dirty when the user has written', async () => {
    writeFileSync(join(repo, 'app.js'), 'export const a = 2\n')
    expect(await isDirty(repo)).toBe(true)
  })
})

describe('committing it on the way past', () => {
  it('commits the memory folder under one standard message', async () => {
    writeMemory()
    expect(await commitMachineOwned(repo)).toBe(true)

    const log = gitq(['log', '-1', '--pretty=%s'])
    expect(log.trim()).toBe('vibepilot: memory update')
    expect(await isDirty(repo)).toBe(false)
  })

  it('touches nothing but that folder', async () => {
    writeMemory()
    writeFileSync(join(repo, 'app.js'), 'export const a = 2\n')
    await commitMachineOwned(repo)

    // The user's edit is still sitting there, uncommitted, exactly as they left it.
    const after = await workingCopyState(repo)
    expect(after.map((e) => e.path)).toContain('app.js')
    expect(after.some((e) => e.machineOwned)).toBe(false)
    expect(gitq(['show', '--stat', '--pretty=', 'HEAD'])).not.toContain('app.js')
  })

  it('does nothing when there is nothing of its own to commit', async () => {
    expect(await commitMachineOwned(repo)).toBe(false)
  })

  it('does nothing when the folder is gitignored — both arrangements work', async () => {
    writeFileSync(join(repo, '.gitignore'), '.vibepilot/\n')
    gitq(['add', '-A'])
    gitq(['commit', '-qm', 'ignore vibepilot'])
    writeMemory()

    expect(await commitMachineOwned(repo)).toBe(false)
    expect(await isDirty(repo)).toBe(false)
  })
})

describe('the merge that used to be impossible', () => {
  it('merges with memory written mid-run, without being asked to set anything aside', async () => {
    // A teammate's branch with real work on it.
    gitq(['checkout', '-q', '-b', 'vp/1-thing'])
    writeFileSync(join(repo, 'feature.js'), 'export const f = 1\n')
    gitq(['add', '-A'])
    gitq(['commit', '-qm', 'the work'])
    gitq(['checkout', '-q', 'main'])

    // …and the app writing its diary while that happened.
    writeMemory('learned something\n')

    const res = await squashMerge({
      repo,
      branch: 'vp/1-thing',
      baseBranch: 'main',
      message: 'ticket #1',
      // Deliberately NOT set aside: there is nothing of the user's to set aside.
      setAside: false,
    })

    expect(res.ok).toBe(true)
    // Before this change the identical call returned { ok: false, kind: 'dirty' }.
    expect(gitq(['log', '--pretty=%s']).split('\n').filter(Boolean)).toContain(
      'vibepilot: memory update',
    )
  })

  it('still refuses when the user genuinely has unsaved work', async () => {
    gitq(['checkout', '-q', '-b', 'vp/2-thing'])
    writeFileSync(join(repo, 'other.js'), 'export const o = 1\n')
    gitq(['add', '-A'])
    gitq(['commit', '-qm', 'work'])
    gitq(['checkout', '-q', 'main'])

    writeMemory()
    writeFileSync(join(repo, 'app.js'), 'my own edit\n')

    const res = await squashMerge({
      repo,
      branch: 'vp/2-thing',
      baseBranch: 'main',
      message: 'ticket #2',
      setAside: false,
    })

    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.kind).toBe('dirty')
  })
})
