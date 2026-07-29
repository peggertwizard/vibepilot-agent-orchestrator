import type { Epic, EpicPiece, Ticket } from '@shared/types'
import { all, get, id, json, now, parseJson, run, tx } from '../index'
import { createTicket, updateTicket } from './tickets'

/**
 * Epics: one request, several linked tickets.
 *
 * A proposal is persisted because the split is meant to be argued about — you merge two
 * pieces, drop one, reorder — and that conversation must survive a restart. Once you accept,
 * `pieces_json` is emptied: the tickets are the epic from then on, and a second copy of the
 * breakdown could only drift out of agreement with them.
 */

type Row = Record<string, unknown>

function map(r: Row): Epic {
  return {
    id: r['id'] as string,
    projectId: r['project_id'] as string,
    title: r['title'] as string,
    shortLabel: r['short_label'] as string,
    colourIndex: (r['colour_index'] as number) ?? 0,
    summary: (r['summary'] as string) ?? '',
    status: r['status'] as Epic['status'],
    proposedByAgentId: (r['proposed_by_agent_id'] as string | null) ?? null,
    pieces: parseJson<EpicPiece[]>(r['pieces_json'], []),
    createdAt: r['created_at'] as number,
    updatedAt: r['updated_at'] as number,
  }
}

export function listEpics(projectId: string): Epic[] {
  return all<Row>(
    `SELECT * FROM epics WHERE project_id = ? AND status IN ('proposed','active','done')
     ORDER BY created_at`,
    projectId,
  ).map(map)
}

export function getEpic(epicId: string): Epic | null {
  const r = get<Row>('SELECT * FROM epics WHERE id = ?', epicId)
  return r ? map(r) : null
}

export function proposeSplit(input: {
  projectId: string
  title: string
  shortLabel: string
  summary: string
  pieces: EpicPiece[]
  proposedByAgentId: string | null
}): Epic {
  const eid = id()
  const t = now()
  // Colour by position, so two live epics never collide and the palette cycles predictably.
  const existing = get<{ n: number }>(
    'SELECT COUNT(*) AS n FROM epics WHERE project_id = ?',
    input.projectId,
  )
  run(
    `INSERT INTO epics
       (id, project_id, title, short_label, colour_index, summary, proposed_by_agent_id,
        pieces_json, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    eid,
    input.projectId,
    input.title,
    input.shortLabel,
    existing?.n ?? 0,
    input.summary,
    input.proposedByAgentId,
    json(input.pieces),
    t,
    t,
  )
  return getEpic(eid)!
}

/**
 * Turn an accepted breakdown into real tickets.
 *
 * `pieces` overrides what was proposed — that is how "accept, but merge the last two" works
 * from the UI without a separate edit round-trip.
 */
export function acceptSplit(epicId: string, pieces?: EpicPiece[]): Ticket[] {
  return tx(() => {
    const e = getEpic(epicId)
    if (!e || e.status !== 'proposed') return []
    const list = pieces ?? e.pieces
    if (list.length === 0) return []

    // Two passes: every ticket must exist before any of them can name a dependency, because
    // dependencies are stored as ticket NUMBERS and a number does not exist until insert.
    const created = list.map((p) =>
      createTicket({
        projectId: e.projectId,
        title: p.title,
        body: p.body,
        lane: 'backlog',
        sizeNote: p.sizeNote,
      }),
    )
    created.forEach((t, i) => {
      const deps = (list[i]!.dependsOnIndexes ?? [])
        .filter((n) => Number.isInteger(n) && n >= 0 && n < created.length && n !== i)
        .map((n) => created[n]!.number)
      run(
        'UPDATE tickets SET epic_id = ?, depends_on_json = ?, updated_at = ? WHERE id = ?',
        epicId,
        json(deps),
        now(),
        t.id,
      )
    })

    run(
      "UPDATE epics SET status = 'active', pieces_json = '[]', resolved_at = ?, updated_at = ? WHERE id = ?",
      now(),
      now(),
      epicId,
    )
    return created.map((t) => ({ ...t, epicId }))
  })
}

export function rejectSplit(epicId: string): void {
  run(
    "UPDATE epics SET status = 'rejected', resolved_at = ?, updated_at = ? WHERE id = ?",
    now(),
    now(),
    epicId,
  )
}

/** Close an epic once every child is done. Called after any ticket moves. */
export function reconcileEpic(epicId: string): void {
  const rows = all<{ lane: string; archived_at: number | null }>(
    'SELECT lane, archived_at FROM tickets WHERE epic_id = ?',
    epicId,
  )
  const live = rows.filter((r) => r.archived_at === null)
  if (live.length === 0) return
  const allDone = live.every((r) => r.lane === 'done')
  run(
    'UPDATE epics SET status = ?, updated_at = ? WHERE id = ? AND status IN (?, ?)',
    allDone ? 'done' : 'active',
    now(),
    epicId,
    'active',
    'done',
  )
}

/**
 * Ticket numbers this ticket is waiting on that are not finished.
 *
 * `depends_on_json` existed in v1 and was never read, which meant the board could show you a
 * ticket as ready when its prerequisite had not been written yet.
 */
export function unmetDependencies(projectId: string, ticketId: string): number[] {
  const t = get<{ depends_on_json: string }>(
    'SELECT depends_on_json FROM tickets WHERE id = ?',
    ticketId,
  )
  const deps = parseJson<number[]>(t?.depends_on_json, [])
  if (deps.length === 0) return []
  const done = new Set(
    all<{ number: number }>(
      "SELECT number FROM tickets WHERE project_id = ? AND lane = 'done'",
      projectId,
    ).map((r) => r.number),
  )
  return deps.filter((n) => !done.has(n))
}

export function setEpicLabel(epicId: string, patch: { title?: string; shortLabel?: string }): void {
  const e = getEpic(epicId)
  if (!e) return
  run(
    'UPDATE epics SET title = ?, short_label = ?, updated_at = ? WHERE id = ?',
    patch.title ?? e.title,
    patch.shortLabel ?? e.shortLabel,
    now(),
    epicId,
  )
}

/** Detach a ticket from its epic without deleting either. */
export function unlinkTicket(ticketId: string): void {
  run('UPDATE tickets SET epic_id = NULL, updated_at = ? WHERE id = ?', now(), ticketId)
  void updateTicket
}
