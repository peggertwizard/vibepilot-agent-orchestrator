import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, openDb } from '../src/main/db'
import { flushWrites } from '../src/main/db/writer'
import { addProject, getProject, updateProject } from '../src/main/db/repos/projects'
import { createAgent } from '../src/main/db/repos/agents'
import { createTicket, getTicket, updateTicket } from '../src/main/db/repos/tickets'
import { acceptRoute, proposeRoute, proposedRoute } from '../src/main/db/repos/routes'
import { freeDependents, mergeTicket, shouldAutoMerge } from '../src/main/engine/merge'
import { sweepEmptyReady } from '../src/main/engine/board'
import type { Project, Ticket } from '../src/shared/types'

/**
 * Finished work landing on its own.
 *
 * The behaviour this replaces: a chain of finished tickets became a queue of merge buttons,
 * each blocked by the one above it, the whole thing jammed on "unsaved work" that was
 * vibePilot's own memory folder — and the ticket that depended on all of them sat still for as
 * long as the human took to notice. *"like you get nothing done... this is unacceptable."*
 *
 * What is asserted here is mostly the **refusals**, because those are what make an automatic
 * merge safe to have at all.
 */

let repo: string
let projectId: string
let agentId: string
let n = 0

const gitq = (args: string[], cwd = repo): string =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  })

/** A ticket with real commits on its own branch, ready to merge. */
function builtTicket(title = `Thing ${++n}`): Ticket {
  const t = createTicket({ projectId, title, body: '', lane: 'todo' })
  const branch = `vp/${t.number}-thing`
  gitq(['checkout', '-q', '-b', branch])
  writeFileSync(join(repo, `f${t.number}.js`), `export const v = ${t.number}\n`)
  gitq(['add', '-A'])
  gitq(['commit', '-qm', `work for ${t.number}`])
  gitq(['checkout', '-q', 'main'])
  updateTicket(t.id, { branch, readyToMerge: true, mergeState: 'ready', assigneeAgentId: agentId })
  flushWrites()
  return getTicket(t.id)!
}

const project = (): Project => getProject(projectId)!

beforeAll(() => {
  openDb(join(mkdtempSync(join(tmpdir(), 'vp-db-')), 'test.db'))
  repo = mkdtempSync(join(tmpdir(), 'vp-repo-'))
  gitq(['init', '-q', '-b', 'main'])
  writeFileSync(join(repo, 'base.js'), 'export const b = 0\n')
  gitq(['add', '-A'])
  gitq(['commit', '-qm', 'initial'])

  projectId = addProject({ path: repo, name: 'Land' }).id
  createAgent({
    projectId,
    name: 'Pilot',
    role: 'pilot',
    provider: 'claude',
    model: 'sonnet',
    isPilot: true,
  })
  agentId = createAgent({
    projectId,
    name: 'Robin',
    role: 'builder',
    provider: 'claude',
    model: 'sonnet',
    isRoster: true,
  }).id
})

afterAll(() => {
  flushWrites()
  closeDb()
})

beforeEach(() => {
  updateProject(projectId, { autoMerge: 'green', autoStart: 'never' })
})

describe('the default', () => {
  it('is on, because waiting for a button on every merge is what broke', () => {
    const fresh = addProject({ path: mkdtempSync(join(tmpdir(), 'vp-f-')), name: 'Fresh' })
    expect(fresh.autoMerge).toBe('green')
  })
})

describe('deciding whether to land it', () => {
  it('lands finished work whose checks passed', () => {
    const t = builtTicket()
    expect(shouldAutoMerge(project(), t, true).yes).toBe(true)
  })

  it('refuses when the checks failed', () => {
    const t = builtTicket()
    expect(shouldAutoMerge(project(), t, false).yes).toBe(false)
  })

  /**
   * `null` is "nothing was run", not "they failed". Reading it as failure would silently
   * disable the feature on every project without a test command — the projects most likely
   * to want it.
   */
  it('treats no configured checks as permission, not as failure', () => {
    const t = builtTicket()
    expect(shouldAutoMerge(project(), t, null).yes).toBe(true)
  })

  it('never lands anything when set to off', () => {
    updateProject(projectId, { autoMerge: 'off' })
    const t = builtTicket()
    expect(shouldAutoMerge(project(), t, true).yes).toBe(false)
  })

  it('lands without checks when set to always', () => {
    updateProject(projectId, { autoMerge: 'always' })
    const t = builtTicket()
    expect(shouldAutoMerge(project(), t, false).yes).toBe(true)
  })

  /** A conflict is a decision waiting for a person; retrying it forever would bury the reason. */
  it('never retries a ticket that already conflicted', () => {
    const t = builtTicket()
    updateTicket(t.id, { mergeState: 'conflict' })
    flushWrites()
    expect(shouldAutoMerge(project(), getTicket(t.id)!, true).yes).toBe(false)
  })
})

describe('actually merging', () => {
  it('lands the work on the base branch', async () => {
    const t = builtTicket()
    const res = await mergeTicket(t.id, { auto: true })

    expect(res.ok).toBe(true)
    expect(gitq(['show', `main:f${t.number}.js`])).toContain('export const v')
    expect(getTicket(t.id)!.mergeState).toBe('merged')
  })

  /** vibePilot's own memory folder must never be what stops a merge. */
  it('is not blocked by the app’s own memory writes', async () => {
    const t = builtTicket()
    mkdirSync(join(repo, '.vibepilot', 'memory', 'project'), { recursive: true })
    writeFileSync(join(repo, '.vibepilot', 'memory', 'project', 'decisions.md'), 'learned\n')

    const res = await mergeTicket(t.id, { auto: true })
    expect(res.ok).toBe(true)
  })

  it('stops on the user’s own uncommitted work rather than moving it', async () => {
    const t = builtTicket()
    writeFileSync(join(repo, 'base.js'), 'export const b = 999\n')

    const res = await mergeTicket(t.id, { auto: true })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.kind).toBe('dirty')

    // Untouched — the whole point of stopping.
    expect(gitq(['status', '--porcelain'])).toContain('base.js')
    gitq(['checkout', '--', 'base.js'])
  })

  /** An empty branch would produce an empty commit and a ticket claiming to have done something. */
  it('refuses a branch with nothing on it, and settles the ticket instead', async () => {
    const t = createTicket({ projectId, title: 'Ghost', body: '', lane: 'todo' })
    gitq(['branch', `vp/${t.number}-ghost`])
    updateTicket(t.id, {
      branch: `vp/${t.number}-ghost`,
      readyToMerge: true,
      mergeState: 'ready',
    })
    flushWrites()

    const res = await mergeTicket(t.id, { auto: true })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.kind).toBe('empty')

    // Swept, not left sitting in Waiting for you for ever — this is the #5 case.
    const after = getTicket(t.id)!
    expect(after.readyToMerge).toBe(false)
    expect(after.lane).toBe('done')
  })
})

describe('sweeping ghosts', () => {
  it('clears a ready ticket whose branch is empty', async () => {
    const t = createTicket({ projectId, title: 'Old ready', body: '', lane: 'todo' })
    gitq(['branch', `vp/${t.number}-old`])
    updateTicket(t.id, { branch: `vp/${t.number}-old`, readyToMerge: true, mergeState: 'ready' })
    flushWrites()

    const settled = await sweepEmptyReady(projectId)
    expect(settled.map((x) => x.number)).toContain(t.number)
    expect(getTicket(t.id)!.readyToMerge).toBe(false)
  })

  it('leaves a ready ticket that genuinely has commits', async () => {
    const t = builtTicket()
    const settled = await sweepEmptyReady(projectId)
    expect(settled.map((x) => x.number)).not.toContain(t.number)
    expect(getTicket(t.id)!.readyToMerge).toBe(true)
  })
})

describe('freeing what was waiting', () => {
  /**
   * The #6/#7/#8 shape: #8 depends on #6, #6 lands, #8 should stop waiting — and somebody
   * should say so. The block was always correct and always silent, which is why finishing #7
   * first looked like the app was stuck.
   */
  /**
   * A dependency clears when the work it depends on is **finished**, not when it merges.
   *
   * That distinction only became real once dependent tickets started sharing a branch: the
   * later ticket is built on top of the earlier one's commits, in the same worktree, so the
   * code is already there. Waiting for a merge would deadlock — the branch cannot merge until
   * every ticket on it is done, and the later ticket could not start until the branch merged.
   */
  it('frees a waiter as soon as what it depends on is finished', () => {
    const blocker = createTicket({ projectId, title: 'Blocker', body: '', lane: 'todo' })
    const waiter = createTicket({
      projectId,
      title: 'Waits',
      body: '',
      lane: 'todo',
      dependsOn: [blocker.number],
    })
    proposeRoute({
      ticketId: waiter.id,
      projectId,
      rationale: 'r',
      proposedByAgentId: null,
      steps: [{ kind: 'build', note: null, brief: 'go', assigneeAgentId: agentId }],
    })
    flushWrites()

    // Nothing has been built yet, so the waiter genuinely cannot start.
    expect(freeDependents(projectId)).not.toContain(waiter.number)

    // The blocker's route completes. Its commits now exist on the branch they share.
    updateTicket(blocker.id, { readyToMerge: true, mergeState: 'ready' })
    flushWrites()

    expect(freeDependents(projectId)).toContain(waiter.number)
  })

  /**
   * The other half of grouping, and the guarantee that makes it safe.
   *
   * Tickets in one chain share a branch, so merging the first alone would land the second's
   * half-written work under the first's name. The branch waits until everything on it is
   * finished — which is precisely what "these must land together" meant.
   */
  it('refuses to merge a shared branch while a ticket on it is unfinished', async () => {
    const first = builtTicket('Chain head')
    const second = createTicket({
      projectId,
      title: 'Chain tail',
      body: '',
      lane: 'todo',
      dependsOn: [first.number],
    })
    flushWrites()

    const res = await mergeTicket(first.id, { auto: true })
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.kind).toBe('waiting')
      expect(res.reason).toContain(`#${second.number}`)
    }
    // Nothing landed, and the first ticket is still ready rather than marked failed.
    expect(getTicket(first.id)!.mergeState).toBe('ready')
  })

  it('lands every ticket on the branch once the last one is done', async () => {
    const first = builtTicket('Pair head')
    const second = createTicket({
      projectId,
      title: 'Pair tail',
      body: '',
      lane: 'todo',
      dependsOn: [first.number],
    })
    // The tail finishes on the same branch — which is what sharing one means.
    updateTicket(second.id, {
      branch: first.branch,
      readyToMerge: true,
      mergeState: 'ready',
    })
    flushWrites()

    const res = await mergeTicket(first.id, { auto: true })
    expect(res.ok).toBe(true)
    // Both marked merged. Marking only the trigger would leave the other sitting against a
    // branch with nothing left to give — a ghost, manufactured fresh.
    expect(getTicket(first.id)!.mergeState).toBe('merged')
    expect(getTicket(second.id)!.mergeState).toBe('merged')
  })

  it('says nothing about work that was never blocked', async () => {
    const t = builtTicket()
    await mergeTicket(t.id, { auto: true })
    // A ticket with no dependencies was never waiting, so announcing it would be noise.
    const freed = freeDependents(projectId)
    expect(freed).not.toContain(t.number)
  })

  it('does not re-announce a ticket already under way', async () => {
    const blocker = builtTicket('Blocker two')
    const waiter = createTicket({
      projectId,
      title: 'Already going',
      body: '',
      lane: 'todo',
      dependsOn: [blocker.number],
    })
    proposeRoute({
      ticketId: waiter.id,
      projectId,
      rationale: 'r',
      proposedByAgentId: null,
      steps: [{ kind: 'build', note: null, brief: 'go', assigneeAgentId: agentId }],
    })
    acceptRoute(proposedRoute(waiter.id)!.id)
    flushWrites()

    await mergeTicket(blocker.id, { auto: true })
    expect(freeDependents(projectId)).not.toContain(waiter.number)
  })
})
