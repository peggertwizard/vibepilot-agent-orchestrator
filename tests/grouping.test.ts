import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeDb, openDb } from '../src/main/db'
import { flushWrites } from '../src/main/db/writer'
import { addProject } from '../src/main/db/repos/projects'
import { createTicket, getTicket } from '../src/main/db/repos/tickets'
import { branchGroupFor, groupMembers } from '../src/main/engine/grouping'

/**
 * One branch per thing that must land together.
 *
 * *"why would I need for those tickets 3 different branches? isn't that overkill?"* — and then
 * the sharper follow-up: *"what defines one request? what if in one message I mention totally
 * different unrelated things?"*
 *
 * Both obvious answers are wrong. Per-ticket is what produced three branches, three worktrees
 * and three merges for one sequential job. Per-message is wrong because a message is not a unit
 * of work. The unit is the dependency chain, which the app already records.
 */

let projectId: string

beforeAll(() => {
  openDb(join(mkdtempSync(join(tmpdir(), 'vp-db-')), 'test.db'))
  const repo = mkdtempSync(join(tmpdir(), 'vp-repo-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  projectId = addProject({ path: repo, name: 'Group' }).id
})

afterAll(() => {
  flushWrites()
  closeDb()
})

describe('what shares a branch', () => {
  it('gives an independent ticket its own', () => {
    const t = createTicket({ projectId, title: 'Alone', body: '', lane: 'todo' })
    flushWrites()
    expect(branchGroupFor(t.id)?.number).toBe(t.number)
    expect(groupMembers(getTicket(t.id)!)).toEqual([t.number])
  })

  /** The #6 → #8 shape: built on top of each other, so they cannot land in either order. */
  it('puts a dependency chain on one branch, keyed on the lowest number', () => {
    const a = createTicket({ projectId, title: 'First', body: '', lane: 'todo' })
    const b = createTicket({
      projectId,
      title: 'Second',
      body: '',
      lane: 'todo',
      dependsOn: [a.number],
    })
    const c = createTicket({
      projectId,
      title: 'Third',
      body: '',
      lane: 'todo',
      dependsOn: [b.number],
    })
    flushWrites()

    // All three answer with the same key, from whichever end you ask.
    expect(branchGroupFor(a.id)?.number).toBe(a.number)
    expect(branchGroupFor(b.id)?.number).toBe(a.number)
    expect(branchGroupFor(c.id)?.number).toBe(a.number)
    expect(groupMembers(getTicket(c.id)!)).toEqual([a.number, b.number, c.number])
  })

  /**
   * The question behind the question. Two unrelated things asked for in one message must not
   * end up sharing a branch just because they arrived together.
   */
  it('keeps unrelated tickets apart even when they were asked for at once', () => {
    const x = createTicket({ projectId, title: 'One thing', body: '', lane: 'todo' })
    const y = createTicket({ projectId, title: 'Another thing', body: '', lane: 'todo' })
    flushWrites()

    expect(branchGroupFor(x.id)?.number).not.toBe(branchGroupFor(y.id)?.number)
  })

  it('walks the chain in both directions', () => {
    const first = createTicket({ projectId, title: 'Base', body: '', lane: 'todo' })
    const second = createTicket({
      projectId,
      title: 'On top',
      body: '',
      lane: 'todo',
      dependsOn: [first.number],
    })
    flushWrites()

    /*
     * Asking from the *earlier* ticket has to give the same answer as asking from the later
     * one. Following only the dependsOn direction would give two tickets in one chain
     * different branches, which is worse than not grouping at all.
     */
    expect(branchGroupFor(first.id)?.number).toBe(branchGroupFor(second.id)?.number)
  })

  it('is stable when a later ticket joins the chain', () => {
    const root = createTicket({ projectId, title: 'Root', body: '', lane: 'todo' })
    flushWrites()
    const before = branchGroupFor(root.id)?.number

    createTicket({
      projectId,
      title: 'Joins later',
      body: '',
      lane: 'todo',
      dependsOn: [root.number],
    })
    flushWrites()

    /*
     * The key must not move when the group grows — a branch already exists under it, and
     * re-keying would strand the work already committed there. Ticket numbers only go up, so
     * the lowest is fixed once the group has formed.
     */
    expect(branchGroupFor(root.id)?.number).toBe(before)
  })
})
