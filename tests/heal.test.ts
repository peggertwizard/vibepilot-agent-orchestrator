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
import { listMessages } from '../src/main/db/repos/messages'
import { acceptRoute, proposeRoute } from '../src/main/db/repos/routes'
import {
  STUCK_GRACE_MS,
  detectStuckSteps,
  healStuckSteps,
  resetHealState,
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
