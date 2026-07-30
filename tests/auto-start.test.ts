import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, openDb } from '../src/main/db'
import { enqueueWrite, flushWrites } from '../src/main/db/writer'
import { addProject, updateProject } from '../src/main/db/repos/projects'
import { createAgent } from '../src/main/db/repos/agents'
import { createTicket, updateTicket } from '../src/main/db/repos/tickets'
import { acceptedRoute, proposeRoute, proposedRoute } from '../src/main/db/repos/routes'
import { routing } from '../src/main/engine/routing'

/**
 * When work is allowed to begin without being asked.
 *
 * The rule is one sentence — **work starts on its own, it never starts invisibly** — and the
 * thing being asserted here is the second half as much as the first. `apply` writes the
 * notice and emits the board change before the process spawns, because an earlier version
 * did it the other way round and a teammate was running before anything appeared on screen.
 */

let repo: string
let projectId: string
let builderId: string
let n = 0

/** A ticket with a proposed route, ready to be decided on. */
function routed(steps: Array<{ kind: 'build' | 'review' | 'research'; assign?: boolean }>) {
  const t = createTicket({ projectId, title: `Thing ${++n}`, body: 'x', lane: 'todo' })
  proposeRoute({
    ticketId: t.id,
    projectId,
    rationale: 'because',
    proposedByAgentId: null,
    steps: steps.map((s) => ({
      kind: s.kind,
      note: null,
      brief: 'do it',
      assigneeAgentId: s.assign ? builderId : null,
    })),
  })
  flushWrites()
  return { ticket: t, route: proposedRoute(t.id)! }
}

beforeAll(() => {
  openDb(join(mkdtempSync(join(tmpdir(), 'vp-db-')), 'test.db'))
  repo = mkdtempSync(join(tmpdir(), 'vp-repo-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'x', '--allow-empty'], {
    cwd: repo,
  })

  projectId = addProject({ path: repo, name: 'Auto' }).id
  createAgent({ projectId, name: 'Pilot', role: 'pilot', provider: 'claude', model: 'sonnet', isPilot: true })
  builderId = createAgent({
    projectId,
    name: 'Robin',
    role: 'builder',
    provider: 'claude',
    model: 'sonnet',
    isRoster: true,
  }).id
})

afterAll(() => {
  flushWrites()
  closeDb()
})

beforeEach(() => {
  updateProject(projectId, { autoStart: 'never', spendCeilingUsd: null, launchPaused: false })
})

describe('never', () => {
  /**
   * `simple` is the default now, changed in migration 023.
   *
   * 019 chose `never` so that upgrading changed nothing — the right instinct, and answered
   * since, repeatedly and directly: "no more approving", "I don't want to press any buttons".
   * Making a ticket happen took two approvals in two different places, and that was the
   * bureaucracy the app exists to remove. `simple` starts a one-step route with a named
   * assignee; everything longer, reviewed, or uncertain still waits.
   */
  it('is no longer the default — one press, not two', () => {
    const fresh = addProject({ path: mkdtempSync(join(tmpdir(), 'vp-fresh-')), name: 'Fresh' })
    expect(fresh.autoStart).toBe('simple')
  })

  it('starts nothing', () => {
    const { route, ticket } = routed([{ kind: 'build', assign: true }])
    expect(routing.maybeAutoStart(route, true)).toBe(false)
    expect(acceptedRoute(ticket.id)).toBeNull()
  })
})

describe('simple', () => {
  beforeEach(() => updateProject(projectId, { autoStart: 'simple' }))

  it('starts a single assigned build', () => {
    const { route, ticket } = routed([{ kind: 'build', assign: true }])
    expect(routing.maybeAutoStart(route, true)).toBe(true)
    const accepted = acceptedRoute(ticket.id)
    expect(accepted).not.toBeNull()
    // Recorded as automatic, so the history says who decided.
    expect(accepted!.autoAccepted).toBe(true)
  })

  it('waits when the route has more than one step', () => {
    const { route, ticket } = routed([
      { kind: 'build', assign: true },
      { kind: 'review', assign: true },
    ])
    expect(routing.maybeAutoStart(route, true)).toBe(false)
    expect(acceptedRoute(ticket.id)).toBeNull()
  })

  it('waits when nobody is on it — there would be nothing to launch', () => {
    const { route } = routed([{ kind: 'build' }])
    expect(routing.maybeAutoStart(route, true)).toBe(false)
  })

  it('waits when the Pilot said it was not sure', () => {
    const { route } = routed([{ kind: 'build', assign: true }])
    // Autonomy is not the absence of judgement. `confident: false` already means "ask".
    expect(routing.maybeAutoStart(route, false)).toBe(false)
  })
})

describe('always', () => {
  beforeEach(() => updateProject(projectId, { autoStart: 'always' }))

  it('starts a multi-step route', () => {
    const { route, ticket } = routed([{ kind: 'build', assign: true }, { kind: 'review' }])
    expect(routing.maybeAutoStart(route, true)).toBe(true)
    expect(acceptedRoute(ticket.id)).not.toBeNull()
  })

  it('still refuses when the Pilot is unsure', () => {
    const { route } = routed([{ kind: 'build', assign: true }])
    expect(routing.maybeAutoStart(route, false)).toBe(false)
  })

  /**
   * The one that matters most once the button is gone.
   *
   * `spend_ceiling_usd` was stored, validated and read by nothing. That was survivable while a
   * human pressed Start each time and saw the number; with no button, the ceiling stops being a
   * backstop and becomes the only control.
   */
  it('refuses over the spend ceiling', () => {
    updateProject(projectId, { spendCeilingUsd: 0.001 })
    const { route, ticket } = routed([{ kind: 'build', assign: true }])
    // A run with real cost against this project.
    enqueueWrite(
      `INSERT INTO usage_events
         (id, project_id, agent_id, run_id, provider, model, cost_usd, created_at)
       VALUES ('u1', ?, ?, 'run1', 'claude', 'sonnet', 5.0, ?)`,
      projectId,
      builderId,
      Date.now(),
    )
    flushWrites()

    expect(routing.maybeAutoStart(route, true)).toBe(false)
    expect(acceptedRoute(ticket.id)).toBeNull()
  })

  /** A dependency is a fact about the work, not a scheduling wait. It refuses rather than queues. */
  it('refuses when a dependency has not landed', () => {
    const blocker = createTicket({ projectId, title: 'First', body: '', lane: 'todo' })
    const { route, ticket } = routed([{ kind: 'build', assign: true }])
    updateTicket(ticket.id, { dependsOn: [blocker.number] })
    flushWrites()

    expect(routing.maybeAutoStart(route, true)).toBe(false)
    expect(acceptedRoute(ticket.id)).toBeNull()
  })
})
