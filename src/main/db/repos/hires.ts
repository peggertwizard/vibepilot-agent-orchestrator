import type { Agent, AgentRole, HireProposal, ProviderId } from '@shared/types'
import { all, bool, fromBool, get, id, now, run, tx } from '../index'
import { createAgent, findAgentByName } from './agents'

/**
 * Hire proposals. The Pilot suggests; the user decides who exists.
 *
 * Persisted rather than held in memory for the same reason ticket drafts are: the card has
 * to survive an app restart while the user thinks about it.
 */

type Row = Record<string, unknown>

function map(r: Row): HireProposal {
  return {
    id: r['id'] as string,
    projectId: r['project_id'] as string,
    proposedByAgentId: (r['proposed_by_agent_id'] as string | null) ?? null,
    name: r['name'] as string,
    role: r['role'] as Exclude<AgentRole, 'pilot'>,
    provider: r['provider'] as ProviderId,
    model: r['model'] as string,
    instructions: (r['instructions'] as string) ?? '',
    why: (r['why'] as string) ?? '',
    fromBootstrap: fromBool(r['from_bootstrap']),
    ticketId: (r['ticket_id'] as string | null) ?? null,
    status: r['status'] as HireProposal['status'],
    agentId: (r['agent_id'] as string | null) ?? null,
    createdAt: r['created_at'] as number,
  }
}

export function listOpenHires(projectId: string): HireProposal[] {
  return all<Row>(
    "SELECT * FROM hire_proposals WHERE project_id = ? AND status = 'pending' ORDER BY created_at",
    projectId,
  ).map(map)
}

export function getHire(hireId: string): HireProposal | null {
  const r = get<Row>('SELECT * FROM hire_proposals WHERE id = ?', hireId)
  return r ? map(r) : null
}

export function proposeHire(input: {
  projectId: string
  proposedByAgentId: string | null
  name: string
  role: Exclude<AgentRole, 'pilot'>
  provider?: ProviderId
  model: string
  instructions?: string
  why: string
  fromBootstrap?: boolean
  ticketId?: string | null
}): HireProposal {
  const hid = id()
  run(
    `INSERT INTO hire_proposals
       (id, project_id, proposed_by_agent_id, name, role, provider, model, instructions, why,
        from_bootstrap, ticket_id, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    hid,
    input.projectId,
    input.proposedByAgentId,
    input.name,
    input.role,
    input.provider ?? 'claude',
    input.model,
    input.instructions ?? '',
    input.why,
    bool(input.fromBootstrap),
    input.ticketId ?? null,
    now(),
  )
  return getHire(hid)!
}

/** Accepting a proposal is the only path from "the Pilot suggested it" to a real teammate. */
export function acceptHire(
  hireId: string,
  overrides?: { name?: string; model?: string; instructions?: string },
): Agent | null {
  return tx(() => {
    const h = getHire(hireId)
    if (!h || h.status !== 'pending') return null
    const name = overrides?.name?.trim() || h.name
    if (findAgentByName(h.projectId, name)) return null

    const agent = createAgent({
      projectId: h.projectId,
      name,
      role: h.role,
      provider: h.provider,
      model: overrides?.model ?? h.model,
      instructions: overrides?.instructions ?? h.instructions,
      isRoster: true,
      ephemeral: false,
    })
    run(
      "UPDATE hire_proposals SET status = 'hired', agent_id = ?, resolved_at = ? WHERE id = ?",
      agent.id,
      now(),
      hireId,
    )
    return agent
  })
}

export function rejectHire(hireId: string): void {
  run(
    "UPDATE hire_proposals SET status = 'rejected', resolved_at = ? WHERE id = ?",
    now(),
    hireId,
  )
}
