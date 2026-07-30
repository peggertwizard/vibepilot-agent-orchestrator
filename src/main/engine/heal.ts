import type { Ticket, TicketRoute } from '@shared/types'
import { activeStep } from '@shared/types'
import { bus } from '../bus'
import { getAgent, setAgentStatus } from '../db/repos/agents'
import { addMessage, getQuestion } from '../db/repos/messages'
import { getProject, listProjects } from '../db/repos/projects'
import { acceptedRoute, assignStep } from '../db/repos/routes'
import { checkoutBase, currentBranch } from '../git/branches'
import { blockingChanges } from '../git/repo'
import { isTicketBranch } from '../git/worktree'
import { getTicket, listTickets } from '../db/repos/tickets'
import { flushWrites } from '../db/writer'
import { notifyUser } from '../notify'
import * as gate from './gate'
import { manager } from './manager'
import { pilot } from './pilot'
import { launchTeammate } from './teammate'

/**
 * Putting work back on its feet.
 *
 * A route step says `active`, a teammate is assigned to it, and **nothing is running**. The
 * board shows the ticket sitting there; the message log's last line is an error from twenty
 * minutes ago; the Pilot says "restarted it" and it stalls again. Watching that happen is what
 * this file is for: *"if this is detected it needs to fire a fix of some sort."*
 *
 * Two causes were confirmed in real use, and they want the same remedy:
 *
 *   1. **The launch itself failed.** Before 0.3.1, `launchTeammate` read `mcpServer.url`
 *      without ever starting the server, so every path except "the Pilot went first" threw.
 *      The step stayed `active` for ever because nothing walks routes looking for orphans.
 *   2. **The model call failed.** Rate limits on the big model, mid-run. Transient, clears on
 *      its own, and the only correct response is to try again a few minutes later.
 *
 * The remedy is a **resume**, not a fresh start: the session id and the worktree have been
 * persisted since the process layer was built precisely so a restart carries on rather than
 * re-reading the codebase and redoing committed work.
 *
 * What this file deliberately does not do: retry every tick. Retries run on a cooldown
 * (`HEAL_COOLDOWN_MS`) — often enough that a cleared rate limit is picked up on its own, rare
 * enough that a genuinely broken step costs one cheap failed spawn per cooldown rather than a
 * hammering loop. The escalation message still fires once, so a person still hears about it.
 */

/** How long a step may sit `active` with nothing behind it before it counts as stuck. */
export const STUCK_GRACE_MS = 5 * 60_000

export interface StuckStep {
  ticket: Ticket
  /** Null when the step has nobody on it at all — see `carryForward`. */
  agentId: string | null
  agentName: string | null
  /** The step, so an unassigned one can be assigned rather than only reported. */
  stepId: string
  stepKind: string
  /** The brief the step was launched with, so a resume lands in the same job. */
  brief: string | null
  /** What the agent's status line said, or why the board calls it stuck. */
  said: string | null
}

/**
 * Who should pick up a step that has nobody on it.
 *
 * Not a judgement — both candidates are already recorded, and both are the answer the app
 * gives elsewhere. The person who finished the previous step is the one the route cards mean
 * by *"same agent carries the approved plan into the build, no cold start"*; the ticket's own
 * assignee is who the board has been showing all along. If neither exists, this returns null
 * and a person is asked, because inventing an assignee is exactly the kind of guess that ends
 * with the wrong teammate rewriting somebody else's work.
 */
function carryForward(ticket: Ticket, route: TicketRoute): string | null {
  const done = [...route.steps].reverse().find((x) => x.status === 'done' && x.assigneeAgentId)
  for (const id of [done?.assigneeAgentId, ticket.assigneeAgentId]) {
    if (!id) continue
    const who = getAgent(id)
    if (who && who.projectId === ticket.projectId) return who.id
  }
  return null
}

/**
 * Steps that claim to be running and are not.
 *
 * Deliberately **not** a status allowlist. The obvious version checks for `error` or
 * `stalled`, and misses the case that produced this file: a step activated by `advance_step`
 * whose launch never happened at all, whose agent still reads `idle` or `done` from the step it
 * finished ten minutes ago. Absence of a process is the fact; the status is commentary on it.
 *
 * The grace period is what keeps a launch that is merely *slow* out of this list — a spawn
 * takes seconds, and `queued` is checked separately because the gate holding work back is the
 * cap doing its job, not a fault.
 */
export function detectStuckSteps(projectId: string, now = Date.now()): StuckStep[] {
  const out: StuckStep[] = []

  for (const ticket of listTickets(projectId)) {
    /*
     * A cancelled ticket is not a stalled one.
     *
     * `archivedAt` was never checked here, so the heal pass treated a ticket the user had just
     * cancelled exactly like one that had stalled — and helpfully restarted the agent on it.
     * *"i clicked cancel and now junior dev is working on the ticket thats not even in the
     * kanban anymore"*: the card was gone from the board and the work carried on regardless,
     * because the one pass whose job is to restart things could not see that it had been
     * called off.
     */
    if (ticket.archivedAt) continue
    if (ticket.lane === 'done' || ticket.readyToMerge) continue
    const route = acceptedRoute(ticket.id)
    const step = activeStep(route)
    if (!step || !route) continue

    /*
     * A step that is active with nobody on it.
     *
     * This was skipped outright — the loop required an assignee, on the reasoning that there
     * is nobody to restart. True, and it left the board saying "1 ticket is stuck, nobody is
     * actually working on it" beside a row of idle teammates, with nothing anywhere able to
     * change that. `derivePlacement` has always called this stuck; it needed *assigning*, not
     * restarting, and the candidate is already recorded.
     */
    if (!step.assigneeAgentId) {
      /*
       * A route that has never got going is the commonest stall, and this was blind to it.
       *
       * The old rule exempted any route with no finished step, reading that as "waiting to be
       * picked up rather than stalled". That is true for about five minutes and false for ever
       * afterwards — and it is *permanent*, so a route whose very first step never got an
       * assignee could never be detected. A single-build route, which is most of them, has no
       * earlier step to finish, so it was excluded by construction: accepted, active, nobody on
       * it, invisible to the one pass that exists to fix exactly that. Found sitting in a real
       * project as `#1 [todo] build:active(NOBODY)`.
       *
       * Time is the honest test, and it is the same test the assigned branch below already
       * uses. `updatedAt` moves when the route is accepted, so the grace starts from the
       * moment the work was supposed to begin.
       */
      if (now - route.updatedAt < STUCK_GRACE_MS) continue
      out.push({
        ticket,
        agentId: null,
        agentName: null,
        stepId: step.id,
        stepKind: step.kind,
        brief: step.brief,
        said: `${step.kind} has nobody assigned, and the work before it is done.`,
      })
      continue
    }

    const who = getAgent(step.assigneeAgentId)
    if (!who) continue

    // Running, or about to be. Neither is stuck.
    /*
     * Busy, not merely *registered*. A Codex run stays in the table between turns — a turn is a
     * process there — so `forAgent` was true for ever and this pass skipped every Codex teammate
     * it ever saw. The automatic heal could not fire for them at all.
     */
    if (manager.isBusy(who.id)) continue
    if (gate.isQueued(who.id)) continue

    /*
     * Give a launch time to actually happen before calling it a failure — unless the app has
     * already declared it dead.
     *
     * `stalled` is written by exactly one thing: `markAllStalledOnBoot`, whose whole premise is
     * that a child's stdio cannot be reattached after the parent process dies, so nothing from
     * before this launch is recoverable. There is no slow launch to wait for. Worse, that
     * function stamps `updated_at = now()`, so the grace period restarted at boot and the first
     * heartbeat tick three minutes later was still inside it — work interrupted by a restart
     * sat there for six minutes-plus behind a Restart button, which is the *"even though I
     * answered the questions earlier"* screenshot.
     */
    if (who.status !== 'stalled' && now - who.updatedAt < STUCK_GRACE_MS) continue

    out.push({
      ticket,
      agentId: who.id,
      agentName: who.name,
      stepId: step.id,
      stepKind: step.kind,
      brief: step.brief,
      said: who.statusLine,
    })
  }

  return out
}

/**
 * Start a teammate again on a ticket, resuming its session.
 *
 * Shared by the heartbeat, the Pilot's `restart_step` tool and the restart button, so the
 * three cannot drift apart. The ticket is a **parameter** rather than something this looks up:
 * the heartbeat already knows exactly which ticket the orphaned step belongs to, and searching
 * for "a ticket this agent is assigned to" can find a stale one from a previous job.
 */
export function relaunchAssignee(input: {
  agentId: string
  ticketId: string
  brief?: string | null
  /** What to show on the agent card while it waits for a slot. */
  because: string
  pilotAgentId?: string
}): boolean {
  const who = getAgent(input.agentId)
  const ticket = getTicket(input.ticketId)
  if (!who || !ticket) return false

  setAgentStatus(who.id, 'queued', input.because)
  flushWrites()
  bus.emitDomain({ type: 'agents:changed', projectId: who.projectId })

  gate.submit({
    projectId: who.projectId,
    agentId: who.id,
    run: () =>
      launchTeammate({
        projectId: who.projectId,
        agentId: who.id,
        name: who.name,
        role: who.role,
        provider: who.provider,
        model: who.model,
        ticketId: ticket.id,
        brief:
          input.brief ??
          `Carry on with #${ticket.number}: ${ticket.title}. Check what you have already ` +
            `done before redoing any of it.`,
        pilotAgentId: input.pilotAgentId ?? '',
        /*
         * The whole point. A cold start re-reads the codebase and repeats work already
         * sitting committed in the worktree.
         */
        resumeSessionId: who.sessionId,
      }).catch((e: Error) => {
        /*
         * Without this the rejection is unhandled — `gate.begin` does `void run()` — and the
         * agent freezes at `queued` for ever, which is worse than the failure it is hiding:
         * `queued` reads as "waiting for a slot" everywhere, including to this file's own
         * detector, so nothing ever looks at it again.
         */
        setAgentStatus(who.id, 'error', e.message.slice(0, 120))
        bus.emitDomain({ type: 'agents:changed', projectId: who.projectId })
      }),
  })

  return true
}

/**
 * When each teammate was last given an automatic restart.
 *
 * This was a lifetime counter — one attempt per teammate per app run — and that single rule is
 * what turned every transient failure into a permanent one. "The model call failed" is a rate
 * limit: it clears on its own, and the file's own design note says the three-minute tick is the
 * backoff. But the first relaunch to hit the limit burned the only attempt, so the ticket sat
 * "in progress" with an errored agent and *nothing anywhere would ever try again* until the app
 * was restarted. Seen live on #5: assigned, red, idle roster, no recovery.
 *
 * A cooldown is the honest shape for a transient fault: retry, but never sooner than
 * `HEAL_COOLDOWN_MS` after the last try. A genuinely broken step now costs one cheap failed
 * spawn per cooldown instead of one per tick — and instead of being silently abandoned. The
 * escalation message still fires once, so the user still hears about it.
 *
 * Cleared when the teammate completes a run, so an agent that worked for two hours and then
 * stalled is retried immediately rather than waiting out a cooldown from this morning.
 */
const attempts = new Map<string, number>()

/** How long a failed automatic restart waits before it may try again. */
export const HEAL_COOLDOWN_MS = 15 * 60_000

function mayRetry(key: string, now: number): boolean {
  const last = attempts.get(key)
  return last === undefined || now - last >= HEAL_COOLDOWN_MS
}

export function clearHealAttempts(agentId: string): void {
  attempts.delete(agentId)
}

/** Test seam — the module keeps state for the life of the process. */
export function resetHealState(): void {
  attempts.clear()
  escalated.clear()
}

const escalated = new Set<string>()

/**
 * Find stuck steps and do something about them.
 *
 * Returns the tickets it acted on, so the caller can say so. `autoStart: 'never'` means the
 * user asked to press the button themselves — relaunching for them would be exactly the
 * surprise that setting exists to prevent, so those projects only ever get the report, which
 * surfaces in the Needs-you popover.
 */
export function healStuckSteps(
  projectId: string,
  relaunch: typeof relaunchAssignee = relaunchAssignee,
  now = Date.now(),
): number[] {
  const project = getProject(projectId)
  if (!project) return []

  const healed: number[] = []

  for (const stuck of detectStuckSteps(projectId, now)) {
    /*
     * Nobody on it. Put the obvious person on it, then treat it as a normal launch.
     *
     * Keyed on the ticket rather than an agent, because there is no agent yet — and a failed
     * assignment must not get a second free go every three minutes for the same reason a
     * failed restart does not.
     */
    if (!stuck.agentId) {
      const key = `assign:${stuck.ticket.id}`
      const route = acceptedRoute(stuck.ticket.id)
      const candidate = route ? carryForward(stuck.ticket, route) : null

      if (!mayRetry(key, now) || !candidate || project.autoStart === 'never') {
        escalate(projectId, stuck, project.autoStart === 'never' || !candidate)
        continue
      }

      attempts.set(key, now)
      assignStep(stuck.ticket.id, stuck.stepId, candidate)
      flushWrites()

      if (!relaunch({
        agentId: candidate,
        ticketId: stuck.ticket.id,
        brief: stuck.brief,
        because: `Starting #${stuck.ticket.number}`,
      })) {
        continue
      }

      addMessage({
        projectId,
        agentId: null,
        authorType: 'system',
        kind: 'notice',
        body:
          `#${stuck.ticket.number}: the ${stuck.stepKind} step had nobody on it and the work ` +
          `before it was done. ${getAgent(candidate)?.name ?? 'Someone'} carried on with it — ` +
          `they did the step before, so nothing is re-read from scratch.`,
      })
      healed.push(stuck.ticket.number)
      continue
    }

    if (!mayRetry(stuck.agentId, now) || project.autoStart === 'never') {
      escalate(projectId, stuck, project.autoStart === 'never')
      continue
    }

    attempts.set(stuck.agentId, now)
    if (!relaunch({
      agentId: stuck.agentId,
      ticketId: stuck.ticket.id,
      brief: stuck.brief,
      because: `Restarting #${stuck.ticket.number}`,
    })) {
      continue
    }

    addMessage({
      projectId,
      agentId: null,
      authorType: 'system',
      kind: 'notice',
      body:
        `#${stuck.ticket.number}: ${stuck.agentName} had stopped` +
        (stuck.said ? ` (${stuck.said})` : '') +
        ` — restarted automatically, resuming where it left off. Nothing was lost.`,
    })
    healed.push(stuck.ticket.number)
  }

  if (healed.length > 0) {
    flushWrites()
    bus.emitDomain({ type: 'messages:changed', projectId })
    bus.emitDomain({ type: 'agents:changed', projectId })
  }

  return healed
}

/**
 * Out of automatic options — say so, once, everywhere that survives a dead Pilot.
 *
 * `notifyUser` and the message row both work with no Pilot process; `pilot.notify` is a
 * best-effort extra. That ordering matters: the failure this handles is frequently *why* the
 * Pilot is not running.
 */
function escalate(projectId: string, stuck: StuckStep, manualOnly: boolean): void {
  const key = `${stuck.agentId ?? 'unassigned'}:${stuck.ticket.id}`
  if (escalated.has(key)) return
  escalated.add(key)

  const why = !stuck.agentId
    ? `#${stuck.ticket.number} has reached its ${stuck.stepKind} step with nobody on it, and ` +
      `vibePilot could not work out who should carry it on. Put somebody on it from the ` +
      `ticket, or tell the Pilot to.`
    : manualOnly
      ? `#${stuck.ticket.number} is assigned to ${stuck.agentName} but nothing is running it. ` +
        `This project starts work only when you say so, so it is waiting for you.`
      : `#${stuck.ticket.number} stopped again after being restarted automatically` +
        (stuck.said ? ` — ${stuck.said}` : '') +
        `. It needs you now: restart it from the agents panel, or hand the step to someone else.`

  addMessage({
    projectId,
    agentId: null,
    authorType: 'system',
    kind: manualOnly ? 'notice' : 'error',
    body: why,
  })
  flushWrites()
  bus.emitDomain({ type: 'messages:changed', projectId })

  if (!manualOnly) {
    notifyUser({
      projectId,
      title: `#${stuck.ticket.number} is stuck`,
      body: stuck.agentName
        ? `${stuck.agentName} stopped twice. ${stuck.ticket.title}`
        : `Nobody is on it. ${stuck.ticket.title}`,
    })
    pilot.notify(projectId, why)
  }
}

/**
 * You answered, and nothing woke up.
 *
 * The exact sequence, after the machine came back from hibernation: the soft timeout inside
 * `ask_user` had fired while the lid was shut (Windows fires an overdue timer immediately on
 * resume), so the waiter was gone. The agent was supposed to call `await_answer` to keep
 * waiting — but its connection to the model had died with the sleep, so that turn never
 * happened. The question stayed open, the card stayed on screen with working buttons, and
 * answering it wrote the answer to the database where nobody was left to read it.
 *
 * `askUserGate.wait` already handles the other half of this — *"already answered while we were
 * away (e.g. the process restarted)"* — so the only missing piece was something to restart it.
 *
 * Returns whether it started anything.
 */
export function wakeAsker(questionId: string): boolean {
  const q = getQuestion(questionId)
  if (!q) return false

  const who = getAgent(q.agentId)
  if (!who) return false

  // Running or queued: it will pick the answer up itself. Restarting would take the process
  // away from a turn that is mid-flight.
  if (manager.isBusy(who.id) || gate.isQueued(who.id)) return false

  /*
   * The Pilot is not a teammate and has no ticket — it is woken through its own path, which
   * knows how to resume its session and does not go through the concurrency gate.
   */
  if (who.isPilot) {
    void pilot
      .ensure(q.projectId, who.model)
      .then(() =>
        pilot.notify(
          q.projectId,
          `The user answered the question you were waiting on. Call \`await_answer\` with ` +
            `question_id ${q.id} to collect it, then carry on.`,
        ),
      )
      .catch(() => undefined)
    return true
  }

  const ticketId = q.ticketId ?? listTickets(q.projectId).find((t) => t.assigneeAgentId === who.id)?.id
  if (!ticketId) return false

  const started = relaunchAssignee({
    agentId: who.id,
    ticketId,
    brief:
      `You asked: "${q.question}"\n\nThe user has answered it. Call \`await_answer\` with ` +
      `question_id ${q.id} to read the answer, then carry on with what you were doing. ` +
      `Check what you had already done before redoing any of it.`,
    because: 'Picking your answer up',
  })

  if (started) {
    addMessage({
      projectId: q.projectId,
      agentId: null,
      authorType: 'system',
      kind: 'notice',
      body:
        `${who.name} had stopped while waiting for your answer — started again to pick it up. ` +
        `Nothing it had already done is redone.`,
    })
    flushWrites()
    bus.emitDomain({ type: 'messages:changed', projectId: q.projectId })
  }

  return started
}

/**
 * Pick up whatever was interrupted.
 *
 * Two callers, one behaviour, because the two situations are the same situation:
 *
 *   - **the machine woke up.** Connections to the model are gone, timers that fell due fire
 *     all at once, and processes Windows preserved are holding sockets that will never answer.
 *   - **the app started.** Everything that was running is definitively dead — you cannot
 *     reattach to a child's stdio after the parent exits — and `markAllStalledOnBoot` has just
 *     said so on every row.
 *
 * The heartbeat would find both eventually. "Eventually" is up to six minutes of a Restart
 * button sitting there while the user wonders what happened to work they already answered
 * questions for, so: check now.
 *
 * Attempts are reset first. Neither of these is the same failure repeating — they are a new
 * situation — and spending a teammate's one automatic restart on the lid closing would leave
 * the rest of the day unprotected. `autoStart: 'never'` still means never; `healStuckSteps`
 * enforces that, so a project set to ask first only ever gets told.
 */
export function resumeInterruptedWork(): void {
  resetHealState()
  for (const project of listProjects()) healStuckSteps(project.id)
}


/**
 * The project folder standing on a branch vibePilot made.
 *
 * This is not a state anybody chose. Teammates work in worktrees precisely so the folder never
 * moves — it is what a dev server serves, what the next worktree branches from, and what every
 * merge lands in. When it drifts onto a ticket branch all three quietly mean something else,
 * and the failure is invisible: work is merged *and* not on screen, both true at once.
 *
 * It happened. `Bash` is not sandboxed — the README has always said so — so an agent that
 * changes directory and runs `git checkout` can do this, and one did. Denying that by
 * enumerating commands is a losing game (`switch`, `-C`, a shell script, a Makefile), so the
 * guarantee is made on the other side: the state is corrected rather than prevented.
 *
 * **Only ticket branches.** A folder on `feature/whatever` is the user's own business and is
 * never touched — that case is surfaced in the Needs-you list and left to them. `vp/<n>-...`
 * is vibePilot's own naming, belongs in a worktree, and can be put back without asking anyone.
 * Nothing is lost either way: the branch and its commits stay exactly where they are.
 */
export async function keepFolderOnBase(projectId: string): Promise<boolean> {
  const project = getProject(projectId)
  if (!project) return false

  const here = await currentBranch(project.path).catch(() => null)
  if (!here || here === project.defaultBaseBranch) return false
  if (!isTicketBranch(here)) return false

  // Real work in the tree is a reason to stop and ask, not to move somebody's files.
  if ((await blockingChanges(project.path)).length > 0) return false

  const r = await checkoutBase(project.path, project.defaultBaseBranch)
  if (!r.ok) return false

  addMessage({
    projectId,
    agentId: null,
    authorType: 'system',
    kind: 'notice',
    body:
      `Your project folder was checked out on \`${here}\` — a branch that belongs to a ticket ` +
      `and should only ever exist in its own working copy. Put back on ` +
      `${project.defaultBaseBranch}, so what you see is what merges land in. ` +
      `\`${here}\` and everything on it are untouched.`,
  })
  flushWrites()
  bus.emitDomain({ type: 'messages:changed', projectId })
  return true
}
