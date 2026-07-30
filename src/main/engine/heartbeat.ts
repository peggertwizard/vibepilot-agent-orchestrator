import { bus } from '../bus'
import { listAgents } from '../db/repos/agents'
import { listProjects } from '../db/repos/projects'
import { listTickets, ticketSpend } from '../db/repos/tickets'
import { acceptedRoute } from '../db/repos/routes'
import { STEP_LABEL, activeStep } from '@shared/types'
import { place, sweepDoneTickets, sweepEmptyReady } from './board'
import { commitMachineOwned } from '../git/worktree'
import { clearHealAttempts, healStuckSteps, keepFolderOnBase } from './heal'
import { syncTicketBranches } from './sync'
import { isQueued } from './gate'
import { manager } from './manager'
import { pilot } from './pilot'

/**
 * Notice when nothing is happening.
 *
 * The Pilot only ever woke when something woke it — a new draft, an accepted route, a finished
 * step. Nothing called it because time had passed. So a ticket that silently stopped
 * progressing produced no event at all, and the Pilot never learned of it: a stuck board
 * stayed stuck until a person happened to look at it and say *"it's been forever"*.
 *
 * This is the missing mechanism, and it is deliberately small. Every condition below is
 * arithmetic on data that already exists — no judgement, no model call to decide whether to
 * make a model call.
 *
 * **It is silent when everything is fine.** A heartbeat that reports "all good" every five
 * minutes costs a Pilot turn every five minutes and teaches you to ignore it.
 */

const TICK_MS = 3 * 60_000
/** How long a live agent may produce nothing before it is worth mentioning. */
const QUIET_MS = 12 * 60_000
/** Fraction of a ticket's budget that counts as "about to run out". */
const BUDGET_WARN = 0.85

interface Problem {
  key: string
  line: string
}

/** Last event seen per agent, so "no output for N minutes" is measurable. */
const lastSeen = new Map<string, number>()

/**
 * Problems already reported, so the same stall is not re-announced every tick.
 *
 * Keyed by problem rather than by ticket: a ticket that is stuck AND over budget is two
 * things worth saying, and one being reported should not silence the other.
 */
const reported = new Map<string, Set<string>>()

let timer: NodeJS.Timeout | null = null

export function startHeartbeat(): void {
  if (timer) return
  bus.onAgent((e) => {
    lastSeen.set(e.agentId, Date.now())
    /*
     * A run that did real work earns the next stall a fresh attempt, immediately.
     *
     * **`completed` specifically, and that word is doing the work.** The intent was always
     * "an agent that ran for two hours and then stalled should not have to wait out a
     * cooldown". But `agent:done` also fires for a run that was killed or that ended the
     * moment it started — and a *failed* restart therefore cleared the very cooldown meant to
     * space out failed restarts. So heal relaunched, the launch died instantly, the death
     * reset the clock, and the next tick relaunched again: the message log filling with
     * "Restarted: resuming the interrupted session" and "stopped: The model call failed",
     * alternating, going nowhere.
     */
    if (e.type === 'agent:done' && e.terminal === 'completed') clearHealAttempts(e.agentId)
  })
  timer = setInterval(() => void tick(), TICK_MS)
  timer.unref?.()
}

export function stopHeartbeat(): void {
  if (timer) clearInterval(timer)
  timer = null
}

/** Exported for tests: one pass, returning what it would say. */
export function scan(projectId: string): Problem[] {
  const out: Problem[] = []
  const agents = new Map(listAgents(projectId).map((a) => [a.id, a]))
  const now = Date.now()

  for (const raw of listTickets(projectId)) {
    const t = place(raw)

    /*
     * A step active with nobody running it. Already computed for the board and the header
     * warning; the difference here is that somebody is told rather than it being drawn on a
     * screen nobody is looking at.
     */
    if (t.stuck) {
      out.push({
        key: `stuck:${t.id}`,
        line: `#${t.number} ${t.title} — ${t.laneBecause} Nothing is progressing it.`,
      })
      continue
    }

    const step = activeStep(acceptedRoute(t.id))
    const who = step?.assigneeAgentId ? agents.get(step.assigneeAgentId) : null
    if (!who || !manager.forAgent(who.id) || isQueued(who.id)) continue

    // Alive, but silent. Not necessarily broken — a long Bash step is quiet too — which is
    // why this reports rather than acts.
    const quietFor = now - (lastSeen.get(who.id) ?? now)
    if (quietFor > QUIET_MS) {
      out.push({
        key: `quiet:${t.id}:${Math.floor(quietFor / QUIET_MS)}`,
        line:
          `#${t.number} ${t.title} — ${who.name} has produced nothing for ` +
          `${Math.round(quietFor / 60_000)} minutes on ${STEP_LABEL[step!.kind]}.`,
      })
    }

    // Approaching the ticket budget, while there is still time to do something about it.
    if (t.budgetUsd) {
      const spent = ticketSpend(t.id).costUsd
      if (spent >= t.budgetUsd * BUDGET_WARN) {
        out.push({
          key: `budget:${t.id}`,
          line:
            `#${t.number} ${t.title} — $${spent.toFixed(2)} of a $${t.budgetUsd.toFixed(2)} ` +
            `budget. It stops at $${(t.budgetUsd * 2).toFixed(2)}.`,
        })
      }
    }
  }

  return out
}

async function tick(): Promise<void> {
  for (const project of listProjects()) {
    /*
     * Housekeeping first, and unconditionally.
     *
     * There used to be an early-out here: no live teammate process meant "nothing to be
     * wrong", skip the project. That is exactly backwards for the failure this file exists to
     * catch. A project where every process has died is not a quiet project — it is the loudest
     * possible symptom, and the check made the heartbeat structurally blind to it. A ticket
     * whose step said `active` with nothing behind it could sit there for ever, and did.
     */
    sweepDoneTickets(project.id)
    healStuckSteps(project.id)

    /*
     * Settle tickets whose branch has nothing left on it.
     *
     * This existed and ran in exactly two places: when a merge was attempted, and behind one
     * IPC call. So the state it exists to clear could only be cleared by pressing the button
     * that could not work — a ticket sat in "Waiting for you" with a merge card that failed
     * every time, and the sweep that would have retired it was reachable only through the
     * failure. Nothing ever looked on its own.
     */
    await sweepEmptyReady(project.id).catch(() => undefined)

    /*
     * Put the app's own folder away, on the clock.
     *
     * `.vibepilot/` is excluded from every merge check, so it never blocks vibePilot. It very
     * much blocks *you*: git refuses to switch branches with it dirty, and it was only ever
     * committed on the way into a merge — so on a project where nothing merged for a while it
     * sat there accumulating, and the one thing standing between the user and checking out
     * their own branch was the app's diary. Worse, an agent that noticed correctly refused to
     * touch it, because hand-committing it is exactly what this exists to stop.
     */
    await commitMachineOwned(project.path).catch(() => undefined)

    /*
     * And put the folder back if something moved it onto a ticket branch. See `keepFolderOnBase`
     * — the one state that is never a choice, and the one that made merged work invisible.
     */
    await keepFolderOnBase(project.id).catch(() => undefined)

    /*
     * And keep every open branch level with the base.
     *
     * The single most valuable thing on this tick. Left alone, branches drift behind the base
     * by one commit per ticket that lands, and the drift is only discovered at merge time as a
     * conflict — in the user's own project folder, long after the agent that could have
     * resolved it has finished. Closing the gap here means it is never wider than one ticket.
     */
    await syncTicketBranches(project.id).catch(() => undefined)

    /*
     * Now the reporting arm, which still needs something to report about. `scan` only ever
     * produces `quiet:` and `budget:` lines for agents with a live process, so on a genuinely
     * idle project this is a no-op — the difference is that heal has already run.
     */
    const tickets = listTickets(project.id)
    if (tickets.length === 0) {
      reported.delete(project.id)
      continue
    }

    const seen = reported.get(project.id) ?? new Set<string>()
    const fresh = scan(project.id).filter((p) => !seen.has(p.key))
    if (fresh.length === 0) continue

    /*
     * Marked reported only if it was actually delivered.
     *
     * `notify` goes nowhere when the Pilot is not running — no process, no message row, no
     * trace. Adding to `seen` regardless would file the problem as told-about when nobody was
     * told, and it would never be raised again for the life of the app run. The failures this
     * reports are frequently *why* the Pilot is not running.
     */
    const delivered = pilot.notify(
      project.id,
      `Something has stopped moving. Nobody has asked you about this — you are being told ` +
        `because time passed and nothing changed:\n\n` +
        fresh.map((p) => `- ${p.line}`).join('\n') +
        `\n\nDeal with it. \`restart_step\` picks up a stalled step where it left off; ` +
        `\`assign_teammate\` puts somebody on a step that has nobody. If a budget is the ` +
        `problem, say so to the user in one line rather than raising it yourself. ` +
        `Do not report this back to the user unless there is something they must decide.`,
    )

    if (delivered) {
      for (const p of fresh) seen.add(p.key)
      reported.set(project.id, seen)
    }
  }
}
