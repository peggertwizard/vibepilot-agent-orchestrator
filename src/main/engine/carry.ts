import type { AgentRole, Ticket } from '@shared/types'
import { all, get } from '../db'
import { getProject } from '../db/repos/projects'
import { getTicket } from '../db/repos/tickets'
import { changedFiles } from '../git/worktree'
import { pathsMentionedIn } from './overlap'

/**
 * What happens to a teammate's context when it finishes.
 *
 * *"what do you think makes most sense to do with the context of a developer that is done?
 * clear it? compress it? let the pilot decide?"* — the question had never been asked in code.
 * A teammate finished, its process exited, its session id sat in the database for ever, and
 * the next ticket spawned a completely cold agent that re-read the codebase from scratch.
 *
 * ## Why not ask the Pilot
 *
 * It was the obvious answer and it is the wrong one. The Pilot never sees a teammate's
 * context — only its report — so it would be judging a summary of a summary, and what it
 * would actually be deciding is "are these two tickets related". That is a cheap question we
 * can answer from data we already have, and answering it mechanically means it cannot drift.
 *
 * ## The rule
 *
 * **Carry when the next ticket touches files the last one just edited. Otherwise start cold.**
 *
 * Plus one case where carrying is always right — the same ticket again, which is rework — and
 * one where it is always wrong: a reviewer must never inherit the builder's context. The whole
 * value of a review step is that it has not already convinced itself, and there is already a
 * check that a reviewer cannot review its own build. This is that principle applied to memory.
 */

export interface CarryDecision {
  /** The session to fork from, or null for a cold start. */
  sessionId: string | null
  /** One line, for `agent_runs` and for anyone reading the log. Always says why. */
  why: string
}

interface PastRun {
  session_id: string | null
  ticket_id: string | null
  started_at: number
}

/**
 * When the base branch last moved.
 *
 * A teammate resumed from a session that predates a merge "knows" a codebase that no longer
 * exists, and will act on it confidently. That is the failure mode this whole feature risks,
 * and it is worse than the cold start it saves — so the cutoff is blunt on purpose.
 */
function lastMergeAt(projectId: string): number {
  const row = get<{ t: number | null }>(
    "SELECT MAX(updated_at) AS t FROM tickets WHERE project_id = ? AND merge_state = 'merged'",
    projectId,
  )
  return row?.t ?? 0
}

export async function decideCarry(input: {
  projectId: string
  agentId: string
  role: AgentRole
  ticket: Ticket
  brief: string
}): Promise<CarryDecision> {
  if (input.role === 'reviewer') {
    return {
      sessionId: null,
      why: 'Reviewer: starts cold on purpose, so it has not already convinced itself.',
    }
  }

  // Most recent run of this agent that got far enough to have a session.
  const past = all<PastRun>(
    `SELECT session_id, ticket_id, started_at FROM agent_runs
     WHERE agent_id = ? AND session_id IS NOT NULL
     ORDER BY started_at DESC LIMIT 5`,
    input.agentId,
  )
  const last = past[0]
  if (!last?.session_id) return { sessionId: null, why: 'Nothing to carry — no previous session.' }

  if (last.started_at < lastMergeAt(input.projectId)) {
    return {
      sessionId: null,
      why: 'Its last session predates a merge to the base branch, so what it knows may be stale.',
    }
  }

  // Same ticket. Rework, a second pass, or an extension of work it already did — always carry.
  if (last.ticket_id === input.ticket.id) {
    return { sessionId: last.session_id, why: 'Same ticket: it already knows this work.' }
  }

  const previous = last.ticket_id ? getTicket(last.ticket_id) : null
  if (!previous?.worktreePath) {
    return { sessionId: null, why: 'Its last ticket left no worktree to compare against.' }
  }

  const project = getProject(input.projectId)
  if (!project) return { sessionId: null, why: 'Project missing.' }

  /*
   * Overlap by file, not by judgement. Plan 25 already computes what a worktree touched;
   * this reuses it rather than inventing a second notion of "related".
   */
  const touched = (await changedFiles(previous.worktreePath, project.defaultBaseBranch)).map(
    (f) => f.path,
  )
  if (touched.length === 0) {
    return { sessionId: null, why: 'Its last ticket changed nothing worth carrying.' }
  }

  const wanted = pathsMentionedIn(
    `${input.ticket.title}\n${input.ticket.body}\n${input.brief}`,
  )
  const shared = touched.filter((f) =>
    wanted.some((w) => f === w || f.endsWith(`/${w}`) || w.endsWith(`/${f}`)),
  )

  return shared.length > 0
    ? {
        sessionId: last.session_id,
        why: `Same files as #${previous.number} (${shared.slice(0, 3).join(', ')}).`,
      }
    : {
        sessionId: null,
        why: 'Different files from its last ticket, so a carried context would be cost without use.',
      }
}
