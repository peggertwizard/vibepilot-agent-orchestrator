import type { LaunchSpec } from '../providers/types'
import { bus } from '../bus'
import { flushWrites } from '../db/writer'
import { getAgent, listAgents, setAgentStatus } from '../db/repos/agents'
import { getProject } from '../db/repos/projects'
import { LIVE_STATUSES } from '@shared/types'
import { manager } from './manager'

/**
 * How many teammates may work at once, and whether any may start at all.
 *
 * `projects.max_concurrent_agents` existed from the first migration, was validated on the way
 * in, and was read by **nothing anywhere in the main process** — so the number you set changed
 * nothing. That is why the control was removed from the screen rather than fixed. This is the
 * enforcement it never had.
 *
 * Two reasons work waits here, and they are deliberately different:
 *
 *   - **at the cap** — the slot frees on its own, so the wait ends on its own
 *   - **paused** — you decided later is better, so nothing moves until you say
 *
 * A parked launch is not a lost one. It keeps its place in a queue, the agent sits at `queued`
 * with a reason you can read on the board, and it goes the moment there is room.
 */

export interface Parked {
  projectId: string
  agentId: string
  run: () => Promise<void>
}

/** FIFO. First ready is first to go — an ordering nobody has to think about. */
const queue: Parked[] = []

/**
 * Agents this gate has started and not yet seen finish.
 *
 * Counted here rather than derived from `manager.forAgent`, which is the bug that made the cap
 * leak: `launchTeammate` sets the agent to `starting` and then awaits worktree creation — the
 * slow part — and does not reach `manager.launchNow` until the very end. So a just-started
 * agent was invisible to the process table, and `release` could drain the whole queue in one
 * synchronous pass, launching everything at once and sailing past the limit.
 */
const started = new Set<string>()

/** Teammates currently holding a slot. The Pilot is not one: it is not a teammate. */
function liveCount(projectId: string): number {
  return listAgents(projectId).filter(
    (a) =>
      !a.isPilot &&
      (started.has(a.id) || (LIVE_STATUSES.includes(a.status) && manager.forAgent(a.id))),
  ).length
}

/** Mark a slot taken the instant we commit to it, not when the process finally appears. */
function begin(agentId: string, run: () => Promise<void>): void {
  started.add(agentId)
  void run().finally(() => {
    /*
     * Only drop the reservation if no process took over. Once the manager knows about the
     * agent, `manager.forAgent` carries the slot and the run-end hook clears it — releasing
     * here as well would let a second agent in while the first is still working.
     */
    if (!manager.forAgent(agentId)) started.delete(agentId)
  })
}

function capFor(projectId: string): number {
  return Math.max(1, getProject(projectId)?.maxConcurrentAgents ?? 3)
}

function isPaused(projectId: string): boolean {
  return getProject(projectId)?.launchPaused ?? false
}

/** What is waiting, and why — so the board can say so rather than looking stuck. */
export function parkedFor(projectId: string): Parked[] {
  return queue.filter((p) => p.projectId === projectId)
}

/**
 * Start now, or park.
 *
 * The caller has already set the agent to `queued`; if it goes straight through, the launch
 * itself moves it on. If it parks, the status stays `queued` with a reason attached, which is
 * the honest description of what is happening.
 */
export function submit(input: Parked): void {
  // Already queued for this agent — a re-entry, not a second piece of work.
  if (queue.some((p) => p.agentId === input.agentId)) return

  if (canStart(input.projectId, input.agentId)) {
    begin(input.agentId, input.run)
    return
  }

  queue.push(input)
  setAgentStatus(input.agentId, 'queued', whyWaiting(input.projectId, input.agentId))
  flushWrites()
  bus.emitDomain({ type: 'agents:changed', projectId: input.projectId })
}

function whyWaiting(projectId: string, agentId: string): string {
  if (manager.forAgent(agentId)) return 'Waiting — already working on something else'
  if (isPaused(projectId)) return 'Waiting — starting new work is paused'
  return `Waiting for a free slot (${capFor(projectId)} at a time)`
}

/**
 * Three separate reasons to wait, and the third is the one that broke the board.
 *
 * One teammate can only hold one process. Two tickets routed to the same reviewer used to mean
 * the second launch hit an early `if (manager.forAgent(who.id)) return` in routing and was
 * **dropped on the floor** — no queue, no retry, nothing to resume it. The step stayed `active`
 * for ever beside an idle agent, which is exactly what "it's been forever" looked like.
 */
function canStart(projectId: string, agentId: string): boolean {
  if (manager.forAgent(agentId)) return false
  return !isPaused(projectId) && liveCount(projectId) < capFor(projectId)
}

/**
 * A slot may have freed. Start whatever is next in line.
 *
 * Called from the one place every run ending passes through — clean exit, crash, timeout, app
 * quit. Anywhere else and a crashed agent would hold its slot forever.
 */
export function release(projectId: string, endedAgentId?: string): void {
  // The slot this agent held is free the moment it ends, whatever the manager thinks.
  if (endedAgentId) started.delete(endedAgentId)
  // Bounded: every pass either starts something or gives up, so a permanently-blocked entry
  // cannot spin. Re-checked per entry because the reason to wait is now per agent, not global.
  for (let guard = 0; guard < 64; guard++) {
    const i = queue.findIndex((p) => p.projectId === projectId && canStart(projectId, p.agentId))
    if (i === -1) return
    const [next] = queue.splice(i, 1)
    if (!next) return
    // Gone since it was parked — deleted, or started some other way. Skip it and keep going.
    if (!getAgent(next.agentId)) continue
    begin(next.agentId, next.run)
  }
}

/** Un-pausing is exactly "a slot may have freed", so it goes through the same door. */
export function resume(projectId: string): void {
  release(projectId)
}

/**
 * Drop a parked launch. Returns whether there was one.
 *
 * Stopping something that has not started yet has to mean something, or Stop is a lie on a
 * queued card.
 */
export function unpark(agentId: string): boolean {
  const i = queue.findIndex((p) => p.agentId === agentId)
  if (i === -1) return false
  queue.splice(i, 1)
  return true
}

/** Only for the spec type to be reachable from callers that build one. */
export type { LaunchSpec }
