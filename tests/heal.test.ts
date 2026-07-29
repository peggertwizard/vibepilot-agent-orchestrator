import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, openDb } from '../src/main/db'
import { flushWrites } from '../src/main/db/writer'
import { addProject, updateProject } from '../src/main/db/repos/projects'
import { createAgent, setAgentStatus } from '../src/main/db/repos/agents'
import { createTicket } from '../src/main/db/repos/tickets'
import { addQuestion, answerQuestion, listMessages } from '../src/main/db/repos/messages'
import { acceptRoute, acceptedRoute, completeActiveStep, proposeRoute } from '../src/main/db/repos/routes'
import { activeStep } from '../src/shared/types'
import {
  STUCK_GRACE_MS,
  detectStuckSteps,
  healStuckSteps,
  resetHealState,
  wakeAsker,
} from '../src/main/engine/heal'

/**
 * Work that stopped, and nothing noticed.
 *
 * The shape from the screenshots: a route step says `active`, a teammate is assigned to it,
 * and there is no process anywhere. Both causes seen in real use land here — a launch that
 * threw before the process existed, and a model call that failed mid-run — and the app's
 * answer to both was to draw a card and wait for a human to spot it.
 *
 * These tests never spawn anything. `manager.forAgent` is empty in a test process by
 * construction, which is exactly the condition under test, and the relaunch is injected so the
 * decision can be asserted without a Claude process.
 */

let projectId: string

beforeAll(() => {
  openDb(join(mkdtempSync(join(tmpdir(), 'vp-db-')), 'test.db'))
  const repo = mkdtempSync(join(tmpdir(), 'vp-repo-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  projectId = addProject({ path: repo, name: 'Heal' }).id
})

afterAll(() => {
  flushWrites()
  closeDb()
})

beforeEach(() => resetHealState())

/** A ticket with an accepted single-step route, assigned, and nothing running it. */
function stalledTicket(title: string): { ticketId: string; agentId: string; number: number } {
  const who = createAgent({
    projectId,
    name: `Dev ${title}`,
    role: 'builder',
    provider: 'claude',
    model: 'sonnet',
    isPilot: false,
    ephemeral: false,
    status: 'error',
  })
  const t = createTicket({ projectId, title, body: '', lane: 'todo' })
  const r = proposeRoute({
    projectId,
    ticketId: t.id,
    proposedByAgentId: null,
    rationale: '',
    steps: [{ kind: 'build', assigneeAgentId: who.id }],
  })
  acceptRoute(r.id, [{ kind: 'build', assigneeAgentId: who.id }])
  setAgentStatus(who.id, 'error', 'The model call failed.')
  flushWrites()
  return { ticketId: t.id, agentId: who.id, number: t.number }
}

/** Far enough in the future that the grace period has passed. */
const later = (): number => Date.now() + STUCK_GRACE_MS + 1_000

describe('noticing that nothing is running', () => {
  it('finds a step that claims to be active with no process behind it', () => {
    const { number } = stalledTicket('Stalled')
    const found = detectStuckSteps(projectId, later())
    expect(found.map((s) => s.ticket.number)).toContain(number)
  })

  /*
   * The obvious implementation filters on `status === 'error' || 'stalled'` and misses the
   * case that produced this file: a step activated by `advance_step` whose launch never
   * happened, whose agent still reads `idle` from the step it finished. Absence of a process
   * is the fact; the status is commentary on it.
   */
  it('counts an idle-looking agent on an active step as stuck', () => {
    const { agentId, number } = stalledTicket('Looks fine')
    setAgentStatus(agentId, 'idle', null)
    flushWrites()
    expect(detectStuckSteps(projectId, later()).map((s) => s.ticket.number)).toContain(number)
  })

  it('leaves a launch that is merely young alone', () => {
    const { number } = stalledTicket('Just started')
    // Now, not later: the row was touched moments ago and a spawn takes seconds.
    expect(detectStuckSteps(projectId, Date.now()).map((s) => s.ticket.number)).not.toContain(
      number,
    )
  })
})

describe('a step with nobody on it', () => {
  /*
   * The screenshot that reopened this: *"1 ticket is stuck — nobody is actually working on
   * it"* beside a rail of idle teammates. `advance_step` had activated a step carrying no
   * assignee, `derivePlacement` correctly called it stuck, and nothing anywhere could act:
   * heal required an assignee, on the reasoning that there is nobody to restart. True, and
   * useless — it needed assigning.
   */
  const halfDone = (title: string): { ticketId: string; agentId: string; number: number } => {
    const who = createAgent({
      projectId,
      name: `Planner ${title}`,
      role: 'builder',
      provider: 'claude',
      model: 'sonnet',
      isPilot: false,
      ephemeral: false,
      status: 'idle',
    })
    const t = createTicket({ projectId, title, body: '', lane: 'todo' })
    const r = proposeRoute({
      projectId,
      ticketId: t.id,
      proposedByAgentId: null,
      rationale: '',
      steps: [
        { kind: 'plan', assigneeAgentId: who.id },
        { kind: 'build', assigneeAgentId: null },
      ],
    })
    const accepted = acceptRoute(r.id, [
      { kind: 'plan', assigneeAgentId: who.id },
      { kind: 'build', assigneeAgentId: null },
    ])!
    // Finish the plan, which activates a build nobody is on.
    completeActiveStep(t.id)
    flushWrites()
    void accepted
    return { ticketId: t.id, agentId: who.id, number: t.number }
  }

  it('is detected, even though there is nobody to restart', () => {
    const { number } = halfDone('Unassigned build')
    const found = detectStuckSteps(projectId, later())
    const mine = found.find((f) => f.ticket.number === number)
    expect(mine).toBeTruthy()
    expect(mine?.agentId).toBeNull()
  })

  it('carries the previous step forward instead of asking', () => {
    const { ticketId, agentId, number } = halfDone('Carry me')
    const calls: Array<{ agentId: string; ticketId: string }> = []
    const healed = healStuckSteps(
      projectId,
      (i) => (i.ticketId === ticketId && calls.push({ agentId: i.agentId, ticketId: i.ticketId }), true),
      later(),
    )

    expect(healed).toContain(number)
    // The person who wrote the plan is the one who should build from it — the route cards
    // already promise exactly that, and it avoids a cold re-read of everything.
    expect(calls[0]?.agentId).toBe(agentId)
    expect(activeStep(acceptedRoute(ticketId))?.assigneeAgentId).toBe(agentId)
  })

  it('does not treat a route nobody has started as stalled', () => {
    const who = createAgent({
      projectId, name: 'Idle hand', role: 'builder', provider: 'claude', model: 'sonnet',
      isPilot: false, ephemeral: false, status: 'idle',
    })
    const t = createTicket({ projectId, title: 'Not begun', body: '', lane: 'todo' })
    const r = proposeRoute({
      projectId, ticketId: t.id, proposedByAgentId: null, rationale: '',
      steps: [{ kind: 'build', assigneeAgentId: null }],
    })
    acceptRoute(r.id, [{ kind: 'build', assigneeAgentId: null }])
    flushWrites()
    void who
    expect(detectStuckSteps(projectId, later()).map((f) => f.ticket.number)).not.toContain(t.number)
  })
})

describe('doing something about it', () => {
  it('restarts once and says so in the log', () => {
    const { ticketId, number } = stalledTicket('Restart me')
    const calls: string[] = []
    const healed = healStuckSteps(projectId, (i) => (calls.push(i.ticketId), true), later())

    expect(healed).toContain(number)
    expect(calls).toContain(ticketId)
    const said = listMessages(projectId).map((m) => m.body).join('\n')
    expect(said).toContain(`#${number}`)
    expect(said).toContain('restarted automatically')
  })

  /*
   * The failure mode this guards is worse than the one it fixes: a relaunch loop against a
   * step that is broken for a reason no restart can address burns the rate limit it is
   * usually waiting on, every three minutes, silently.
   */
  it('does not restart the same teammate twice', () => {
    const { ticketId, number } = stalledTicket('Twice')
    // Filtered to this ticket: every earlier case in this file left a stalled ticket behind,
    // and they are all legitimately healable on a fresh pass.
    const mine: string[] = []
    const record = (i: { ticketId: string }): boolean => (
      i.ticketId === ticketId && mine.push(i.ticketId), true
    )
    healStuckSteps(projectId, record, later())
    const second = healStuckSteps(projectId, record, later())

    expect(second).not.toContain(number)
    expect(mine).toHaveLength(1)
  })

  it('escalates on the second pass instead of retrying', () => {
    const { number } = stalledTicket('Escalate')
    healStuckSteps(projectId, () => true, later())
    healStuckSteps(projectId, () => true, later())

    const errors = listMessages(projectId).filter((m) => m.kind === 'error')
    expect(errors.some((m) => m.body.includes(`#${number}`))).toBe(true)
    expect(errors.some((m) => m.body.includes('needs you'))).toBe(true)
  })

  /*
   * "Ask me first" has to mean it. A project that never starts work by itself must not start
   * work by itself because something broke — that is precisely the surprise the setting exists
   * to prevent, so it gets the report and nothing else.
   */
  it('never starts anything on a project set to ask first', () => {
    updateProject(projectId, { autoStart: 'never' })
    flushWrites()
    const { number } = stalledTicket('Manual only')
    const calls: string[] = []
    const healed = healStuckSteps(projectId, (i) => (calls.push(i.ticketId), true), later())

    expect(healed).toEqual([])
    expect(calls).toEqual([])
    expect(listMessages(projectId).some((m) => m.body.includes(`#${number}`))).toBe(true)
    updateProject(projectId, { autoStart: 'simple' })
    flushWrites()
  })
})


describe('an answer nobody was left to read', () => {
  /*
   * The hibernation shape, exactly as reported: *"after hibernation I answer a few questions
   * from the session that asked them. after that nothing happened, it did not spin back up."*
   *
   * The soft timeout inside `ask_user` falls due while the machine sleeps and Windows fires it
   * the moment it wakes, so the waiter is gone. The agent was supposed to call `await_answer`
   * to keep waiting, but its connection to the model died with the sleep, so that turn never
   * happened. The question stays open with working buttons, and answering it writes the answer
   * somewhere nobody is reading.
   *
   * `askUserGate.wait` has always handled the other half — "already answered while we were
   * away (e.g. the process restarted)". The missing piece was anything to restart it.
   */
  it('starts the asker again, and says so', () => {
    const { ticketId, agentId, number } = stalledTicket('Asked something')
    const q = addQuestion({
      projectId,
      agentId,
      ticketId,
      question: 'Should the site be redeployed after an upgrade?',
    })
    // The user answered while nothing was listening.
    answerQuestion(q.id, 'no', 'user')
    flushWrites()

    expect(wakeAsker(q.id)).toBe(true)
    const said = listMessages(projectId).map((m) => m.body).join(' ')
    expect(said).toContain('waiting for your answer')
    void number
  })

  it('does nothing when the asker is already running', () => {
    // `manager.forAgent` is empty in tests, so the honest version of this check is the other
    // guard: an agent queued to start will collect the answer itself.
    const { ticketId, agentId } = stalledTicket('Queued asker')
    const q = addQuestion({ projectId, agentId, ticketId, question: 'Anything?' })
    answerQuestion(q.id, 'yes', 'user')
    flushWrites()

    // First wake starts it, which puts it through the gate and marks it queued.
    expect(wakeAsker(q.id)).toBe(true)
    // A second answer must not take the process away from a turn that is mid-flight.
    expect(wakeAsker(q.id)).toBe(false)
  })

  it('shrugs at a question that no longer exists', () => {
    expect(wakeAsker('nope')).toBe(false)
  })
})
