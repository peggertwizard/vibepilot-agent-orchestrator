import type { Agent, AgentRole, AgentStatus, EffortLevel, ProviderId } from '@shared/types'
import { all, bool, fromBool, get, id, now, run } from '../index'

type Row = Record<string, unknown>

function map(r: Row): Agent {
  return {
    id: r['id'] as string,
    projectId: r['project_id'] as string,
    parentAgentId: (r['parent_agent_id'] as string | null) ?? null,
    name: r['name'] as string,
    role: r['role'] as AgentRole,
    avatarInitials: r['avatar_initials'] as string,
    provider: r['provider'] as ProviderId,
    model: r['model'] as string,
    effort: (r['effort'] as EffortLevel | null) ?? null,
    isPilot: fromBool(r['is_pilot']),
    ephemeral: fromBool(r['ephemeral']),
    isRoster: fromBool(r['is_roster']),
    instructions: (r['instructions'] as string) ?? '',
    status: r['status'] as AgentStatus,
    statusLine: (r['status_line'] as string | null) ?? null,
    currentTicketId: (r['current_ticket_id'] as string | null) ?? null,
    sessionId: (r['session_id'] as string | null) ?? null,
    worktreePath: (r['worktree_path'] as string | null) ?? null,
    stoppedReason: (r['stopped_reason'] as string | null) ?? null,
    startedAt: (r['started_at'] as number | null) ?? null,
    lastEventAt: (r['last_event_at'] as number | null) ?? null,
    costUsd: (r['cost_usd'] as number) ?? 0,
    resolvedModel: (r['resolved_model'] as string | null) ?? null,
    tokensIn: (r['tokens_in'] as number) ?? 0,
    tokensOut: (r['tokens_out'] as number) ?? 0,
    tokensCacheRead: (r['tokens_cache_read'] as number) ?? 0,
    tokensCacheWrite: (r['tokens_cache_write'] as number) ?? 0,
    contextUsed: (r['context_used'] as number | null) ?? null,
    contextMax: (r['context_max'] as number | null) ?? null,
    createdAt: r['created_at'] as number,
    updatedAt: r['updated_at'] as number,
  }
}

export function listAgents(projectId: string): Agent[] {
  return all<Row>(
    'SELECT * FROM agents WHERE project_id = ? ORDER BY is_pilot DESC, created_at',
    projectId,
  ).map(map)
}

export function getAgent(agentId: string): Agent | null {
  const r = get<Row>('SELECT * FROM agents WHERE id = ?', agentId)
  return r ? map(r) : null
}

export function getPilot(projectId: string): Agent | null {
  const r = get<Row>('SELECT * FROM agents WHERE project_id = ? AND is_pilot = 1', projectId)
  return r ? map(r) : null
}

export function findAgentByName(projectId: string, name: string): Agent | null {
  const r = get<Row>(
    'SELECT * FROM agents WHERE project_id = ? AND lower(name) = lower(?)',
    projectId,
    name,
  )
  return r ? map(r) : null
}

export function initials(name: string): string {
  const parts = name.trim().split(/[\s_-]+/).filter(Boolean)
  if (parts.length === 0) return '??'
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase()
  return (parts[0]![0]! + parts[1]![0]!).toUpperCase()
}

export function createAgent(input: {
  projectId: string
  name: string
  role: AgentRole
  provider: ProviderId
  /** Required. There is deliberately no default model — see MODEL_OPTIONS. */
  model: string
  /** Null means "use the default for this role" — see effortDefaultFor. */
  effort?: EffortLevel | null
  isPilot?: boolean
  ephemeral?: boolean
  parentAgentId?: string | null
  currentTicketId?: string | null
  status?: AgentStatus
  instructions?: string
  isRoster?: boolean
}): Agent {
  const t = now()
  const aid = id()
  run(
    `INSERT INTO agents
       (id, project_id, parent_agent_id, name, role, avatar_initials, provider, model,
        effort, is_pilot, ephemeral, is_roster, instructions, status, current_ticket_id,
        created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    aid,
    input.projectId,
    input.parentAgentId ?? null,
    input.name,
    input.role,
    initials(input.name),
    input.provider,
    input.model,
    input.effort ?? null,
    bool(input.isPilot),
    bool(input.ephemeral ?? !input.isRoster),
    bool(input.isRoster ?? input.isPilot),
    input.instructions ?? '',
    input.status ?? 'idle',
    input.currentTicketId ?? null,
    t,
    t,
  )
  return getAgent(aid)!
}

/**
 * Status is always written BEFORE the corresponding bus event is emitted, so a renderer
 * that refetches at any moment agrees with what the panel is showing.
 */
export function setAgentStatus(
  agentId: string,
  status: AgentStatus,
  statusLine?: string | null,
): void {
  if (statusLine === undefined) {
    run('UPDATE agents SET status = ?, updated_at = ?, last_event_at = ? WHERE id = ?',
      status, now(), now(), agentId)
  } else {
    run(
      'UPDATE agents SET status = ?, status_line = ?, updated_at = ?, last_event_at = ? WHERE id = ?',
      status, statusLine, now(), now(), agentId,
    )
  }
}

export function setAgentStatusLine(agentId: string, statusLine: string): void {
  run('UPDATE agents SET status_line = ?, last_event_at = ?, updated_at = ? WHERE id = ?',
    statusLine, now(), now(), agentId)
}

/**
 * Forget a resume handle that can never work again.
 *
 * A Claude session is bound to the directory it was created in — `--resume` from anywhere else
 * fails with *"No conversation found with session ID"*. That is permanent: the worktree moved
 * or was removed, and no amount of retrying will bring the conversation back. But the handle
 * stayed on the row, so every automatic restart replayed the same impossible resume and failed
 * in exactly the same way, for ever. Clearing it means the next start is a cold one, which
 * works — the branch and its commits are still there to read.
 */
export function clearAgentSession(agentId: string): void {
  run('UPDATE agents SET session_id = NULL, updated_at = ? WHERE id = ?', now(), agentId)
}

/**
 * Forget one session the CLI has told us does not exist.
 *
 * **Both tables, because resuming reads the other one.** `decideCarry` picks what to resume from
 * `agent_runs`, not from the agent row — so clearing only the row (0.7.3) changed nothing: the
 * next restart dug the same dead id back out of history and failed identically.
 *
 * By id, never a blanket wipe. A teammate can have perfectly good sessions on other tickets, and
 * the message names exactly which one is gone. Anything not named keeps working.
 */
/**
 * Throw away everything a teammate is carrying, so its next start is genuinely clean.
 *
 * The escape hatch that was missing, and the user asked the right question: *"why can't we just
 * reset the senior dev?"* Every stuck agent this week ended the same way — some piece of stored
 * state was wrong, nothing on screen could clear it, and the only real remedy was for somebody
 * to find the bad row. A reset makes that a button: it does not need to know *which* piece of
 * state went bad, because it drops all of them.
 *
 * What it clears: the resume handle (on the agent and everywhere in its run history), the error
 * status, and the status line.
 *
 * What it deliberately does **not** touch: the worktree, the branch and the commits. Those are
 * the work. A reset costs the conversation — the agent re-reads what it already did instead of
 * remembering it — and nothing else. That is what makes it safe to reach for first rather than
 * last.
 */
export function resetAgent(agentId: string): void {
  run(
    `UPDATE agents SET session_id = NULL, status = 'idle', status_line = NULL, updated_at = ?
      WHERE id = ?`,
    now(),
    agentId,
  )
  // The run history is where `decideCarry` looks for something to resume. Leaving it would let
  // a reset agent pick its old context straight back up, which is the opposite of a reset.
  run('UPDATE agent_runs SET session_id = NULL, resumed_from = NULL WHERE agent_id = ?', agentId)
}

export function forgetSession(sessionId: string): void {
  if (!sessionId) return
  run('UPDATE agents SET session_id = NULL, updated_at = ? WHERE session_id = ?', now(), sessionId)
  run('UPDATE agent_runs SET session_id = NULL WHERE session_id = ?', sessionId)
  run('UPDATE agent_runs SET resumed_from = NULL WHERE resumed_from = ?', sessionId)
}

export function setAgentSession(agentId: string, sessionId: string, worktreePath?: string | null): void {
  run('UPDATE agents SET session_id = ?, worktree_path = COALESCE(?, worktree_path), started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ?',
    sessionId, worktreePath ?? null, now(), now(), agentId)
}

export function addAgentCost(agentId: string, usd: number): void {
  run('UPDATE agents SET cost_usd = MAX(cost_usd, ?), updated_at = ? WHERE id = ?', usd, now(), agentId)
}

/**
 * Record what a completed turn consumed.
 *
 * Three different accumulation semantics arrive in the same `result` message and
 * each needs its own treatment:
 *
 *   tokens   per-turn      — summed
 *   context  a snapshot    — replaced; it describes headroom now, not history
 *   cost     CUMULATIVE    — replaced, not added. total_cost_usd is the running
 *                            total for the whole CLI process, so adding it every
 *                            turn re-adds everything spent before. That is how a
 *                            $2.58 Pilot came to display $5.71.
 *
 * MAX rather than plain assignment so an out-of-order or zeroed turn cannot walk
 * the figure backwards. The one cost is under-reporting across a --resume
 * boundary, which errs in the safe direction.
 */
export function recordAgentUsage(
  agentId: string,
  u: {
    tokensIn: number
    tokensOut: number
    cacheRead: number
    cacheWrite: number
    contextUsed?: number | null
    contextMax?: number | null
    costUsd?: number
  },
): void {
  run(
    `UPDATE agents SET
       tokens_in           = tokens_in + ?,
       tokens_out          = tokens_out + ?,
       tokens_cache_read   = tokens_cache_read + ?,
       tokens_cache_write  = tokens_cache_write + ?,
       context_used        = COALESCE(?, context_used),
       context_max         = COALESCE(?, context_max),
       cost_usd            = MAX(cost_usd, ?),
       updated_at          = ?
     WHERE id = ?`,
    u.tokensIn,
    u.tokensOut,
    u.cacheRead,
    u.cacheWrite,
    u.contextUsed ?? null,
    u.contextMax ?? null,
    u.costUsd ?? 0,
    now(),
    agentId,
  )
}

/** The alias we passed resolved to this. Recorded once, on the first system/init. */
export function setResolvedModel(agentId: string, resolved: string): void {
  run('UPDATE agents SET resolved_model = ?, updated_at = ? WHERE id = ?', resolved, now(), agentId)
}

export function setAgentTicket(agentId: string, ticketId: string | null): void {
  run('UPDATE agents SET current_ticket_id = ?, updated_at = ? WHERE id = ?', ticketId, now(), agentId)
}

export function deleteAgent(agentId: string): void {
  run('DELETE FROM agents WHERE id = ?', agentId)
}

/** The persistent team you built, Pilot excluded. */
export function listRoster(projectId: string): Agent[] {
  return all<Row>(
    'SELECT * FROM agents WHERE project_id = ? AND is_roster = 1 AND is_pilot = 0 ORDER BY created_at',
    projectId,
  ).map(map)
}

export function updateAgent(
  agentId: string,
  patch: {
    name?: string
    role?: AgentRole
    provider?: ProviderId
    model?: string
    effort?: EffortLevel | null
    instructions?: string
  },
): Agent | null {
  const sets: string[] = []
  const args: (string | number | null)[] = []
  if (patch.name !== undefined) {
    sets.push('name = ?', 'avatar_initials = ?')
    args.push(patch.name, initials(patch.name))
  }
  if (patch.role !== undefined) (sets.push('role = ?'), args.push(patch.role))
  if (patch.provider !== undefined) (sets.push('provider = ?'), args.push(patch.provider))
  if (patch.model !== undefined) {
    sets.push('model = ?')
    args.push(patch.model)
    /*
     * A new alias invalidates the old resolution.
     *
     * `resolved_model` is what the CLI reported it actually ran — meaningful only for the
     * alias that produced it. Left behind after a re-alias it becomes a lie the UI repeats:
     * the model picker learns `alias → resolved` from every roster row, so one agent switched
     * from Sonnet to Opus without this line taught the whole app that "Sonnet" means Opus 5,
     * and every Sonnet chip everywhere said so.
     *
     * Only when it actually changes — the editor sends `model` on every save, and clearing it
     * on a rename would drop a perfectly good label for no reason.
     */
    const before = getAgent(agentId)
    if (before && before.model !== patch.model) sets.push('resolved_model = NULL')
  }
  if (patch.effort !== undefined) (sets.push('effort = ?'), args.push(patch.effort))
  if (patch.instructions !== undefined) (sets.push('instructions = ?'), args.push(patch.instructions))
  if (sets.length === 0) return getAgent(agentId)

  sets.push('updated_at = ?')
  args.push(now(), agentId)
  run(`UPDATE agents SET ${sets.join(', ')} WHERE id = ?`, ...args)
  return getAgent(agentId)
}

/** Called at boot: nothing can legitimately still be running after a restart. */
export function markAllStalledOnBoot(): number {
  const r = run(
    `UPDATE agents SET status = 'stalled', status_line = 'Interrupted when vibePilot closed', updated_at = ?
     WHERE status IN ('starting','thinking','working','waiting_on_you','queued')`,
    now(),
  )
  return r.changes
}

/**
 * Zero the usage counters for every agent on a project.
 *
 * Tokens accumulate for the life of an agent row, which is right for "what has this teammate
 * cost me" and wrong for "what has this cost me since I started paying attention". Deliberately
 * does NOT touch messages, tickets or history — only the counters, so the number restarts
 * without any record of the work disappearing with it.
 */
export function resetProjectUsage(projectId: string): number {
  const rows = all<{ id: string }>('SELECT id FROM agents WHERE project_id = ?', projectId)
  run(
    `UPDATE agents SET tokens_in = 0, tokens_out = 0, tokens_cache_read = 0,
       tokens_cache_write = 0, cost_usd = 0, updated_at = ? WHERE project_id = ?`,
    now(),
    projectId,
  )
  return rows.length
}
