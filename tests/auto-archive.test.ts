import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeDb, openDb } from '../src/main/db'
import { flushWrites } from '../src/main/db/writer'
import { addProject, updateProject } from '../src/main/db/repos/projects'
import { createTicket, getTicket, listTickets, updateTicket } from '../src/main/db/repos/tickets'
import { listMessages } from '../src/main/db/repos/messages'
import { sweepDoneTickets } from '../src/main/engine/board'

/**
 * The Done column that only ever grew.
 *
 * Archiving existed and worked, and was something you had to remember to do, one ticket at a
 * time, from a menu behind an ellipsis. So the one screen that should say *here is what landed*
 * accumulated everything the app had ever finished.
 *
 * The interesting part is not the sweep — it is `done_at`, because the sweep is only as safe as
 * the predicate. `updated_at` moves for a rename; `archived_at` is the consequence, not the
 * clock. So a column that means exactly "finished at", stamped and cleared at the one chokepoint
 * every writer passes through.
 */

let projectId: string
const DAY = 86_400_000

beforeAll(() => {
  openDb(join(mkdtempSync(join(tmpdir(), 'vp-db-')), 'test.db'))
  const repo = mkdtempSync(join(tmpdir(), 'vp-repo-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  projectId = addProject({ path: repo, name: 'Archive' }).id
})

afterAll(() => {
  flushWrites()
  closeDb()
})

describe('when a ticket counts as finished', () => {
  it('stamps done_at on the way into Done', () => {
    const t = createTicket({ projectId, title: 'Lands', body: '', lane: 'todo' })
    expect(getTicket(t.id)?.doneAt).toBeNull()
    updateTicket(t.id, { lane: 'done' })
    expect(getTicket(t.id)?.doneAt).toBeTypeOf('number')
  })

  it('stamps it for a merge too, which never touches the lane on its own', () => {
    const t = createTicket({ projectId, title: 'Merges', body: '', lane: 'todo' })
    updateTicket(t.id, { mergeState: 'merged' })
    expect(getTicket(t.id)?.doneAt).toBeTypeOf('number')
  })

  /*
   * The safety property. A ticket dragged back out has not been finished for three days — it
   * is not finished at all, and a stale timestamp would have the sweep collect it the moment
   * the cutoff passed, from a lane it is actively being worked in.
   */
  it('clears it when the ticket comes back out', () => {
    const t = createTicket({ projectId, title: 'Reopened', body: '', lane: 'todo' })
    updateTicket(t.id, { lane: 'done' })
    updateTicket(t.id, { lane: 'todo' })
    expect(getTicket(t.id)?.doneAt).toBeNull()
  })

  it('does not move the stamp when a done ticket is touched again', () => {
    const t = createTicket({ projectId, title: 'Renamed', body: '', lane: 'done' })
    updateTicket(t.id, { lane: 'done' })
    const first = getTicket(t.id)?.doneAt
    updateTicket(t.id, { title: 'Renamed twice' })
    expect(getTicket(t.id)?.doneAt).toBe(first)
  })
})

describe('the sweep', () => {
  const finished = (title: string): string => {
    const t = createTicket({ projectId, title, body: '', lane: 'todo' })
    updateTicket(t.id, { lane: 'done' })
    flushWrites()
    return t.id
  }

  it('archives what has been done longer than the setting allows', () => {
    const id = finished('Old')
    // Reading from the future rather than backdating the row: the same arithmetic, and it does
    // not require the test to know how the column is written.
    const archived = sweepDoneTickets(projectId, Date.now() + 9 * DAY)
    expect(archived.length).toBeGreaterThan(0)
    expect(getTicket(id)?.archivedAt).toBeTypeOf('number')
    expect(listTickets(projectId).some((t) => t.id === id)).toBe(false)
  })

  it('leaves fresh work alone', () => {
    const id = finished('Yesterday')
    sweepDoneTickets(projectId, Date.now() + 1 * DAY)
    expect(getTicket(id)?.archivedAt).toBeNull()
  })

  /*
   * Finished is not the same as done with. A ticket waiting to merge is exactly the thing the
   * board exists to show you; archiving it would hide the merge card that is the whole point.
   */
  it('never archives something still waiting to merge', () => {
    const t = createTicket({ projectId, title: 'Waiting to land', body: '', lane: 'todo' })
    updateTicket(t.id, { lane: 'done', readyToMerge: true })
    flushWrites()
    sweepDoneTickets(projectId, Date.now() + 30 * DAY)
    expect(getTicket(t.id)?.archivedAt).toBeNull()
  })

  it('does nothing at all when the setting is zero', () => {
    updateProject(projectId, { autoArchiveDays: 0 })
    flushWrites()
    const t = createTicket({ projectId, title: 'Kept for ever', body: '', lane: 'todo' })
    updateTicket(t.id, { lane: 'done' })
    flushWrites()
    expect(sweepDoneTickets(projectId, Date.now() + 365 * DAY)).toEqual([])
    expect(getTicket(t.id)?.archivedAt).toBeNull()
    updateProject(projectId, { autoArchiveDays: 3 })
    flushWrites()
  })

  /*
   * Silence is the one way this could feel like data loss. Work that was on the board and then
   * is not has to be accounted for somewhere the user can find.
   */
  it('says what it archived', () => {
    const t = createTicket({ projectId, title: 'Announced', body: '', lane: 'todo' })
    updateTicket(t.id, { lane: 'done' })
    flushWrites()
    sweepDoneTickets(projectId, Date.now() + 9 * DAY)
    const said = listMessages(projectId).map((m) => m.body).join('\n')
    expect(said).toContain('Archived')
    expect(said).toContain('under Archive')
  })
})
