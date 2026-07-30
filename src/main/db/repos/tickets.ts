import type { Lane, MergeState, StepKind, Ticket, TicketDraft } from '@shared/types'
import { all, bool, fromBool, get, id, json, now, parseJson, run, tx } from '../index'
import { nextTicketNumber } from './projects'

type Row = Record<string, unknown>

function map(r: Row): Ticket {
  return {
    id: r['id'] as string,
    projectId: r['project_id'] as string,
    number: r['number'] as number,
    title: r['title'] as string,
    body: (r['body'] as string) ?? '',
    // Placeholder. `place()` in engine/board.ts overwrites all three before any caller that
    // shows a board sees them — the stored column is a preference, not a fact.
    lane: r['lane'] as Lane,
    stuck: false,
    laneBecause: '',
    waitingFor: [],
    stage: (r['stage'] as StepKind | null) ?? null,
    needsPlanning: fromBool(r['needs_planning']),
    readyToMerge: fromBool(r['ready_to_merge']),
    mergeState: r['merge_state'] as MergeState,
    conflictFiles: parseJson<string[]>(r['conflict_files_json'], []),
    assigneeAgentId: (r['assignee_agent_id'] as string | null) ?? null,
    branch: (r['branch'] as string | null) ?? null,
    worktreePath: (r['worktree_path'] as string | null) ?? null,
    headSha: (r['head_sha'] as string | null) ?? null,
    sizeNote: (r['size_note'] as string | null) ?? null,
    dependsOn: parseJson<number[]>(r['depends_on_json'], []),
    backlogRank: (r['backlog_rank'] as number | null) ?? null,
    budgetUsd: (r['budget_usd'] as number | null) ?? null,
    epicId: (r['epic_id'] as string | null) ?? null,
    doneAt: (r['done_at'] as number | null) ?? null,
    archivedAt: (r['archived_at'] as number | null) ?? null,
    createdAt: r['created_at'] as number,
    updatedAt: r['updated_at'] as number,
  }
}

export function listTickets(projectId: string, includeArchived = false): Ticket[] {
  const sql = includeArchived
    ? 'SELECT * FROM tickets WHERE project_id = ? ORDER BY number'
    : 'SELECT * FROM tickets WHERE project_id = ? AND archived_at IS NULL ORDER BY number'
  return all<Row>(sql, projectId).map(map)
}

export function getTicket(ticketId: string): Ticket | null {
  const r = get<Row>('SELECT * FROM tickets WHERE id = ?', ticketId)
  return r ? map(r) : null
}

export function getTicketByNumber(projectId: string, number: number): Ticket | null {
  const r = get<Row>('SELECT * FROM tickets WHERE project_id = ? AND number = ?', projectId, number)
  return r ? map(r) : null
}

export function createTicket(input: {
  projectId: string
  title: string
  body?: string
  lane?: Lane
  needsPlanning?: boolean
  sizeNote?: string | null
  dependsOn?: number[]
  /** What this one ticket may cost. Null falls back to the step-kind default at launch. */
  budgetUsd?: number | null
}): Ticket {
  // Number allocation and insert share one transaction — otherwise two agents creating a
  // ticket in the same tick collide on (project_id, number).
  return tx(() => {
    const number = nextTicketNumber(input.projectId)
    const t = now()
    const tid = id()
    run(
      `INSERT INTO tickets
         (id, project_id, number, title, body, lane, needs_planning, size_note,
          depends_on_json, budget_usd, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      tid,
      input.projectId,
      number,
      input.title,
      input.body ?? '',
      input.lane ?? 'backlog',
      bool(input.needsPlanning),
      input.sizeNote ?? null,
      json(input.dependsOn ?? []),
      input.budgetUsd ?? null,
      t,
      t,
    )
    return getTicket(tid)!
  })
}

export interface TicketPatch {
  title?: string
  body?: string
  lane?: Lane
  /** Written only by the route repo — it is a mirror of the active step. */
  stage?: StepKind | null
  needsPlanning?: boolean
  readyToMerge?: boolean
  mergeState?: MergeState
  conflictFiles?: string[]
  assigneeAgentId?: string | null
  branch?: string | null
  worktreePath?: string | null
  headSha?: string | null
  sizeNote?: string | null
  budgetUsd?: number | null
  /** Ticket numbers this one waits on. Editable, because a dependency is often noticed late. */
  dependsOn?: number[]
}

const COLUMN: Record<keyof TicketPatch, string> = {
  title: 'title',
  body: 'body',
  lane: 'lane',
  stage: 'stage',
  needsPlanning: 'needs_planning',
  readyToMerge: 'ready_to_merge',
  mergeState: 'merge_state',
  conflictFiles: 'conflict_files_json',
  assigneeAgentId: 'assignee_agent_id',
  branch: 'branch',
  worktreePath: 'worktree_path',
  headSha: 'head_sha',
  sizeNote: 'size_note',
  budgetUsd: 'budget_usd',
  dependsOn: 'depends_on_json',
}

export function updateTicket(ticketId: string, patch: TicketPatch): Ticket | null {
  const sets: string[] = []
  const args: (string | number | null)[] = []
  for (const [k, v] of Object.entries(patch) as [keyof TicketPatch, unknown][]) {
    if (v === undefined) continue
    /*
     * A key with no column would compose `SET undefined = ?` and fail at prepare time with
     * "no such column: undefined" — a message that names neither the field nor the caller.
     * Skipping is not right either; a silently dropped write is worse than a loud one.
     */
    const column = COLUMN[k]
    if (!column) throw new Error(`updateTicket: no column for "${String(k)}"`)
    sets.push(`${column} = ?`)
    if (k === 'conflictFiles' || k === 'dependsOn') args.push(json(v))
    else if (typeof v === 'boolean') args.push(bool(v))
    else args.push(v as string | number | null)
  }
  /*
   * "Done since when" — stamped here rather than by every caller.
   *
   * Four different places move a ticket into done (a drag on the board, the empty-branch
   * sweep, the merge path, an agent finishing its route) and any of them forgetting would
   * leave a ticket that never ages out. Doing it at the one chokepoint they all go through
   * means the column cannot drift from the lane.
   *
   * Cleared on the way back out, because a ticket dragged from Done to To do has not been
   * finished for three days — it is not finished at all, and auto-archive must not collect it.
   */
  if (patch.lane !== undefined || patch.mergeState !== undefined) {
    const before = getTicket(ticketId)
    const finished = patch.lane === 'done' || patch.mergeState === 'merged'
    const reopened =
      patch.lane !== undefined && patch.lane !== 'done' && patch.mergeState !== 'merged'
    if (finished && before?.doneAt === null) (sets.push('done_at = ?'), args.push(now()))
    else if (reopened && before?.doneAt !== null) sets.push('done_at = NULL')
  }

  if (sets.length === 0) return getTicket(ticketId)
  sets.push('updated_at = ?')
  args.push(now(), ticketId)
  run(`UPDATE tickets SET ${sets.join(', ')} WHERE id = ?`, ...args)
  return getTicket(ticketId)
}

/** Archive is not delete: done work stays inspectable. Only the user may truly delete. */
export function archiveTicket(ticketId: string): void {
  run('UPDATE tickets SET archived_at = ?, updated_at = ? WHERE id = ?', now(), now(), ticketId)
}

export function deleteTicket(ticketId: string): void {
  run('DELETE FROM tickets WHERE id = ?', ticketId)
}

/* ── drafts ─────────────────────────────────────────────────────────────────── */

interface DraftPayload {
  title: string
  body: string
  lane: Lane
  needsPlanning: boolean
  ownerHint: string | null
  sizeNote: string | null
  dependsOn: number[]
}

function mapDraft(r: Row): TicketDraft {
  const p = parseJson<DraftPayload>(r['payload_json'], {
    title: '',
    body: '',
    lane: 'backlog',
    needsPlanning: false,
    ownerHint: null,
    sizeNote: null,
    dependsOn: [],
  })
  return {
    id: r['id'] as string,
    projectId: r['project_id'] as string,
    proposedByAgentId: (r['proposed_by_agent_id'] as string | null) ?? null,
    title: p.title,
    body: p.body,
    lane: p.lane,
    needsPlanning: p.needsPlanning,
    ownerHint: p.ownerHint,
    sizeNote: p.sizeNote,
    dependsOn: p.dependsOn,
    status: r['status'] as TicketDraft['status'],
    ticketId: (r['ticket_id'] as string | null) ?? null,
    createdAt: r['created_at'] as number,
  }
}

export function listOpenDrafts(projectId: string): TicketDraft[] {
  return all<Row>(
    "SELECT * FROM ticket_drafts WHERE project_id = ? AND status = 'pending' ORDER BY created_at",
    projectId,
  ).map(mapDraft)
}

export function getDraft(draftId: string): TicketDraft | null {
  const r = get<Row>('SELECT * FROM ticket_drafts WHERE id = ?', draftId)
  return r ? mapDraft(r) : null
}

export function createDraft(input: {
  projectId: string
  proposedByAgentId: string | null
  title: string
  body: string
  lane: Lane
  needsPlanning: boolean
  ownerHint?: string | null
  sizeNote?: string | null
  dependsOn?: number[]
}): TicketDraft {
  const did = id()
  run(
    `INSERT INTO ticket_drafts (id, project_id, proposed_by_agent_id, payload_json, created_at)
     VALUES (?,?,?,?,?)`,
    did,
    input.projectId,
    input.proposedByAgentId,
    json({
      title: input.title,
      body: input.body,
      lane: input.lane,
      needsPlanning: input.needsPlanning,
      ownerHint: input.ownerHint ?? null,
      sizeNote: input.sizeNote ?? null,
      dependsOn: input.dependsOn ?? [],
    }),
    now(),
  )
  return getDraft(did)!
}

export function updateDraftPayload(draftId: string, patch: Partial<DraftPayload>): TicketDraft | null {
  const d = getDraft(draftId)
  if (!d) return null
  run(
    'UPDATE ticket_drafts SET payload_json = ? WHERE id = ?',
    json({
      title: patch.title ?? d.title,
      body: patch.body ?? d.body,
      lane: patch.lane ?? d.lane,
      needsPlanning: patch.needsPlanning ?? d.needsPlanning,
      ownerHint: patch.ownerHint ?? d.ownerHint,
      sizeNote: patch.sizeNote ?? d.sizeNote,
      dependsOn: patch.dependsOn ?? d.dependsOn,
    }),
    draftId,
  )
  return getDraft(draftId)
}

export function resolveDraft(
  draftId: string,
  status: 'created' | 'parked' | 'rejected',
  ticketId?: string | null,
): void {
  run(
    'UPDATE ticket_drafts SET status = ?, ticket_id = ?, resolved_at = ? WHERE id = ?',
    status,
    ticketId ?? null,
    now(),
    draftId,
  )
}

/** Accepting a draft is the only path from "the Pilot suggested it" to a real ticket. */
export function acceptDraft(draftId: string): Ticket | null {
  return tx(() => {
    const d = getDraft(draftId)
    if (!d || d.status !== 'pending') return null
    const ticket = createTicket({
      projectId: d.projectId,
      title: d.title,
      body: d.body,
      lane: d.lane,
      needsPlanning: d.needsPlanning,
      sizeNote: d.sizeNote,
      dependsOn: d.dependsOn,
    })
    resolveDraft(draftId, 'created', ticket.id)
    return ticket
  })
}

/**
 * What the team spent on one ticket.
 *
 * Two corrections are load-bearing, and they are the same two that plan 08 fixed for agents:
 *
 * 1. **`cost_usd` is cumulative per CLI process**, so a naive `SUM` over the ledger counts every
 *    earlier turn again on each row. `MAX` per `run_id`, then add the runs.
 * 2. **Tokens must be weighted.** A raw sum counts the same cached conversation once per API
 *    round-trip, which is where the 41× inflation came from — 225k of distinct content read as
 *    9.27M.
 *
 * And one honest limit: **the Pilot's spend is not attributable to a ticket.** `pilot.ts`'s
 * `usage_events` INSERT omits `ticket_id` entirely, so this is what the *team* spent working it,
 * with the routing and briefing overhead staying project-level. The UI says so rather than
 * quietly under-reporting.
 *
 * `tickets.cost_usd` exists in the schema, is written by nothing and is deliberately left dead:
 * a materialised column is a second thing to keep correct for a number that is cheap to derive.
 */
export function ticketSpend(ticketId: string): {
  costUsd: number
  tokensIn: number
  tokensOut: number
  tokensCacheRead: number
  tokensCacheWrite: number
  turns: number
} {
  const totals = get<Row>(
    `SELECT
       COALESCE(SUM(input_tokens), 0)          AS tin,
       COALESCE(SUM(output_tokens), 0)         AS tout,
       COALESCE(SUM(cache_read_tokens), 0)     AS tread,
       COALESCE(SUM(cache_creation_tokens), 0) AS twrite,
       COUNT(*)                                AS turns
     FROM usage_events WHERE ticket_id = ?`,
    ticketId,
  )

  // MAX per run, then sum the runs — see (1) above.
  const cost = get<Row>(
    `SELECT COALESCE(SUM(m), 0) AS total FROM (
       SELECT MAX(cost_usd) AS m FROM usage_events
       WHERE ticket_id = ? AND run_id IS NOT NULL GROUP BY run_id
     )`,
    ticketId,
  )

  return {
    costUsd: (cost?.['total'] as number | undefined) ?? 0,
    tokensIn: (totals?.['tin'] as number | undefined) ?? 0,
    tokensOut: (totals?.['tout'] as number | undefined) ?? 0,
    tokensCacheRead: (totals?.['tread'] as number | undefined) ?? 0,
    tokensCacheWrite: (totals?.['twrite'] as number | undefined) ?? 0,
    turns: (totals?.['turns'] as number | undefined) ?? 0,
  }
}
