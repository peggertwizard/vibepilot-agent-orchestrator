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
  if (patch.model !== undefined) (sets.push('model = ?'), args.push(patch.model))
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
