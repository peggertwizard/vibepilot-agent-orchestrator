import type { Lane, RouteStep, TicketRoute } from './types'
import { activeStep } from './types'

/**
 * Where a ticket really is.
 *
 * The board used to read a stored `lane` column with six writers and no reconciler, which
 * produced the state that prompted this file: a card sitting in "In progress", badged
 * "ready", assigned to a teammate whose own card said "Finished". Three statements, one
 * screen, one moment, and only one of them true.
 *
 * That was not a missed update. `mark_ready_to_merge` wrote `lane: 'in_progress'`
 * deliberately, because an earlier version wrote `'done'` and that jumped the merge queue —
 * work looked finished before anything had been merged. The fix for "Done is a lie" made
 * "In progress" a lie instead, because **waiting on you was not a state the board could
 * express**. Now it is.
 *
 * So the lane is no longer stored and patched. It is computed here, from the three things
 * that actually know: the route, the assignee's status, and whether a process is live. A
 * stale board is not a bug that was fixed — it is a state with nowhere to live.
 */

/** Everything the derivation is allowed to look at. Nothing else is consulted. */
export interface BoardFacts {
  /** `merged`, or the user dragged it to Done. */
  merged: boolean
  /** The teammate said the work is finished and is waiting to be merged. */
  readyToMerge: boolean
  /** The accepted route, or null when the ticket has not been routed yet. */
  route: TicketRoute | null
  /** Is the active step's assignee holding a live process right now? */
  assigneeLive: boolean
  /** Is it queued behind the concurrency cap, or held by the pause toggle? */
  assigneeQueued: boolean
}

export interface BoardPlacement {
  lane: Lane
  /**
   * The step says active, and nobody is running it.
   *
   * This is the state the user hit twice — once as a review step beside an idle reviewer,
   * once as a finished build still claiming to be in progress. It was always inferrable by
   * cross-checking the agents rail against the board. Making it a value means nobody has to.
   */
  stuck: boolean
  /** Why the card sits where it does, for the tooltip. Always a complete sentence. */
  because: string
}

/** Has anything actually happened on this route yet? */
function hasStarted(steps: RouteStep[]): boolean {
  return steps.some((s) => s.status === 'done' || s.passes > 1 || (s.status === 'rework'))
}

/**
 * The one function. Total over its inputs: every combination of route state, assignee status
 * and process presence returns exactly one lane, which is what `board.property.test.ts`
 * asserts. If you add a lane, add it here first and let the type error find the rest.
 */
export function derivePlacement(f: BoardFacts): BoardPlacement {
  if (f.merged) {
    return { lane: 'done', stuck: false, because: 'Merged.' }
  }

  // Finished-and-waiting outranks everything below it. A ticket whose work is done is not
  // "in progress" however active its route still looks — that inversion is the whole bug.
  if (f.readyToMerge) {
    return { lane: 'waiting', stuck: false, because: 'Finished. Waiting for you to merge it.' }
  }

  if (!f.route) {
    return { lane: 'backlog', stuck: false, because: 'Not routed yet.' }
  }

  const step = activeStep(f.route)

  if (!step) {
    /*
     * No active step, but not necessarily finished.
     *
     * A gated route parks exactly here: the steps before the gate are done, the gated step is
     * still `pending`, and nothing is running. That is the user's move — with the plan now
     * written and readable, which is the point of having planned first.
     */
    const gateAhead = f.route.steps.find((s) => s.status === 'pending' && s.gate)
    if (gateAhead) {
      return {
        lane: 'waiting',
        stuck: false,
        because: `Ready for your sign-off before the ${gateAhead.kind} step starts.`,
      }
    }

    // Every step done but not marked ready: still the user's move, not the app's.
    const allDone = f.route.steps.length > 0 && f.route.steps.every((s) => s.status === 'done')
    return allDone
      ? { lane: 'waiting', stuck: false, because: 'Every step is done. Waiting for you.' }
      : { lane: 'todo', stuck: false, because: 'Routed. Nothing has started.' }
  }

  if (f.assigneeLive) {
    return { lane: 'in_progress', stuck: false, because: 'Being worked on right now.' }
  }

  if (f.assigneeQueued) {
    return { lane: 'todo', stuck: false, because: 'Queued. It starts when a slot frees up.' }
  }

  if (!step.assigneeAgentId) {
    return hasStarted(f.route.steps)
      ? {
          lane: 'in_progress',
          stuck: true,
          because: `${step.kind} has nobody assigned, and the work before it is done.`,
        }
      : { lane: 'todo', stuck: false, because: 'Routed. Waiting for someone to pick it up.' }
  }

  // Assigned, not live, not queued. This is the stall.
  return {
    lane: 'in_progress',
    stuck: true,
    because: 'Assigned, but nothing is running it.',
  }
}
