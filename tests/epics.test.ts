import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeDb, openDb } from '../src/main/db'
import { addProject } from '../src/main/db/repos/projects'
import { getTicket, listTickets, updateTicket } from '../src/main/db/repos/tickets'
import {
  acceptSplit,
  getEpic,
  listEpics,
  proposeSplit,
  reconcileEpic,
  rejectSplit,
  unmetDependencies,
} from '../src/main/db/repos/epics'
import { epicColour } from '../src/shared/types'

/**
 * A big request as one ticket means one agent, sequentially, for hours. As linked tickets it
 * means parallel builders and a board that tells you where things stand.
 *
 * The split is a conversation, so the proposal must be a real persisted thing you can argue
 * with — and dropping a piece must not silently corrupt the dependencies of the ones kept.
 */
describe('epics', () => {
  let projectId: string

  const threePieces = () =>
    proposeSplit({
      projectId,
      title: 'Add authentication',
      shortLabel: 'auth',
      summary: 'Schema, then the API, then the screens.',
      proposedByAgentId: null,
      pieces: [
        { title: 'User table and migration', body: '', dependsOnIndexes: [], sizeNote: null },
        { title: 'Login and session API', body: '', dependsOnIndexes: [0], sizeNote: null },
        { title: 'Sign-in screen', body: '', dependsOnIndexes: [1], sizeNote: 'half a day' },
      ],
    })

  beforeAll(() => {
    openDb(join(mkdtempSync(join(tmpdir(), 'vp-epic-')), 'test.db'))
    projectId = addProject({ path: mkdtempSync(join(tmpdir(), 'vp-eproj-')), name: 'Epics' }).id
  })

  afterAll(() => closeDb())

  it('a proposal creates no tickets', () => {
    const before = listTickets(projectId).length
    const e = threePieces()
    expect(e.status).toBe('proposed')
    expect(e.pieces).toHaveLength(3)
    expect(listTickets(projectId)).toHaveLength(before)
  })

  it('accepting creates linked tickets in the backlog, with dependencies as numbers', () => {
    const e = threePieces()
    const created = acceptSplit(e.id)
    expect(created).toHaveLength(3)
    expect(created.every((t) => t.lane === 'backlog')).toBe(true)
    expect(created.every((t) => t.epicId === e.id)).toBe(true)

    // Positions became real ticket numbers — which only exist after insert, hence two passes.
    expect(getTicket(created[0]!.id)!.dependsOn).toEqual([])
    expect(getTicket(created[1]!.id)!.dependsOn).toEqual([created[0]!.number])
    expect(getTicket(created[2]!.id)!.dependsOn).toEqual([created[1]!.number])

    // The breakdown is emptied: from here the tickets ARE the epic.
    expect(getEpic(e.id)!.pieces).toHaveLength(0)
    expect(getEpic(e.id)!.status).toBe('active')
  })

  it('dropping a piece remaps the dependencies of the ones kept', () => {
    const e = threePieces()
    // Keep pieces 1 and 3, drop the middle — as the UI does when you press "drop".
    const created = acceptSplit(e.id, [
      { title: 'User table and migration', body: '', dependsOnIndexes: [], sizeNote: null },
      { title: 'Sign-in screen', body: '', dependsOnIndexes: [0], sizeNote: null },
    ])
    expect(created).toHaveLength(2)
    expect(
      getTicket(created[1]!.id)!.dependsOn,
      'it must point at the piece that survived, not at a stale position',
    ).toEqual([created[0]!.number])
  })

  it('a dependency that is not done blocks the dependent ticket', () => {
    const e = threePieces()
    const created = acceptSplit(e.id)
    const [first, second] = created

    expect(unmetDependencies(projectId, second!.id)).toEqual([first!.number])
    updateTicket(first!.id, { lane: 'done' })
    expect(unmetDependencies(projectId, second!.id)).toEqual([])
    // A ticket with no dependencies is never blocked.
    expect(unmetDependencies(projectId, first!.id)).toEqual([])
  })

  it('the epic closes once every child is done', () => {
    const e = threePieces()
    const created = acceptSplit(e.id)
    for (const t of created.slice(0, 2)) updateTicket(t.id, { lane: 'done' })
    reconcileEpic(e.id)
    expect(getEpic(e.id)!.status, 'not while one is still open').toBe('active')

    updateTicket(created[2]!.id, { lane: 'done' })
    reconcileEpic(e.id)
    expect(getEpic(e.id)!.status).toBe('done')
  })

  it('a rejected breakdown cannot be accepted afterwards', () => {
    const e = threePieces()
    rejectSplit(e.id)
    expect(acceptSplit(e.id)).toEqual([])
    expect(listEpics(projectId).some((x) => x.id === e.id), 'and it leaves the board').toBe(false)
  })

  it('colours cycle rather than running out', () => {
    expect(epicColour(0)).toBe('var(--epic-1)')
    expect(epicColour(6)).toBe('var(--epic-1)')
    expect(epicColour(-1), 'a negative index must not produce undefined').toBe('var(--epic-6)')
  })
})
