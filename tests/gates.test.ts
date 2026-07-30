import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, openDb } from '../src/main/db'
import { flushWrites } from '../src/main/db/writer'
import { addProject, updateProject } from '../src/main/db/repos/projects'
import { createAgent } from '../src/main/db/repos/agents'
import { createTicket } from '../src/main/db/repos/tickets'
import {
  acceptRoute,
  acceptedRoute,
  approveGate,
  completeActiveStep,
  proposeRoute,
  proposedRoute,
  safePrefixLength,
} from '../src/main/db/repos/routes'
import { routing } from '../src/main/engine/routing'

/**
 * "Plan it now, ask me before you build it."
 *
 * The question that produced this: *"if a ticket is sitting in the backlog but has a plan to
 * it, could it really not start already?"* It could not, and the reason was structural —
 * `completeActiveStep` advanced from step to step unconditionally, so the only way to stop
 * before the build was to never start the plan. The planning phase, which is safe and is
 * exactly what makes the sign-off decision possible, sat unstarted in the backlog.
 */

let projectId: string
let agentId: string
let n = 0

/** A ticket routed plan → build, with the build gated. */
function gatedTicket() {
  const t = createTicket({ projectId, title: `Gated ${++n}`, body: '', lane: 'todo' })
  proposeRoute({
    ticketId: t.id,
    projectId,
    rationale: 'needs sign-off',
    proposedByAgentId: null,
    steps: [
      { kind: 'plan', note: null, brief: 'work it out', assigneeAgentId: agentId },
      { kind: 'build', note: null, brief: 'build it', assigneeAgentId: agentId, gate: true },
    ],
  })
  flushWrites()
  return t
}

beforeAll(() => {
  openDb(join(mkdtempSync(join(tmpdir(), 'vp-db-')), 'test.db'))
  const repo = mkdtempSync(join(tmpdir(), 'vp-repo-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  execFileSync(
    'git',
    ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'x', '--allow-empty'],
    { cwd: repo },
  )

  projectId = addProject({ path: repo, name: 'Gates' }).id
  createAgent({
    projectId,
    name: 'Pilot',
    role: 'pilot',
    provider: 'claude',
    model: 'sonnet',
    isPilot: true,
  })
  agentId = createAgent({
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
  updateProject(projectId, { autoStart: 'never', autoMerge: 'off' })
})

describe('the safe prefix', () => {
  it('is everything before the gate', () => {
    const t = gatedTicket()
    const route = proposedRoute(t.id)!
    // Plan runs; build waits. That is the whole answer to the backlog question.
    expect(safePrefixLength(route)).toBe(1)
  })

  it('is the whole route when nothing is gated', () => {
    const t = createTicket({ projectId, title: 'Open', body: '', lane: 'todo' })
    proposeRoute({
      ticketId: t.id,
      projectId,
      rationale: 'r',
      proposedByAgentId: null,
      steps: [
        { kind: 'build', note: null, brief: 'b', assigneeAgentId: agentId },
        { kind: 'review', note: null, brief: 'r', assigneeAgentId: agentId },
      ],
    })
    flushWrites()
    expect(safePrefixLength(proposedRoute(t.id)!)).toBe(2)
  })
})

describe('stopping at the gate', () => {
  it('does not start the gated step when the one before it finishes', () => {
    const t = gatedTicket()
    acceptRoute(proposedRoute(t.id)!.id)
    flushWrites()

    const out = completeActiveStep(t.id)!
    expect(out.gated).toBe(true)
    // Half done and paused — emphatically not complete. Calling it complete would mark the
    // ticket ready and try to merge a plan document as though it were the feature.
    expect(out.routeComplete).toBe(false)
    expect(out.next?.kind).toBe('build')
    expect(out.next?.status).toBe('pending')
  })

  it('advances normally when there is no gate', () => {
    const t = createTicket({ projectId, title: 'Ungated', body: '', lane: 'todo' })
    proposeRoute({
      ticketId: t.id,
      projectId,
      rationale: 'r',
      proposedByAgentId: null,
      steps: [
        { kind: 'plan', note: null, brief: 'p', assigneeAgentId: agentId },
        { kind: 'build', note: null, brief: 'b', assigneeAgentId: agentId },
      ],
    })
    acceptRoute(proposedRoute(t.id)!.id)
    flushWrites()

    const out = completeActiveStep(t.id)!
    expect(out.gated).toBe(false)
    expect(out.next?.status).toBe('active')
  })
})

describe('approving', () => {
  it('clears the gate and makes the step active', () => {
    const t = gatedTicket()
    acceptRoute(proposedRoute(t.id)!.id)
    completeActiveStep(t.id)
    flushWrites()

    const route = approveGate(t.id)!
    const build = route.steps.find((s) => s.kind === 'build')!
    expect(build.status).toBe('active')
    /*
     * Cleared, not merely stepped over. A gate left set would park the route again at the
     * next advance, which looks exactly like the button not working.
     */
    expect(build.gate).toBe(false)
  })

  it('does nothing when there is no gate waiting', () => {
    const t = gatedTicket()
    acceptRoute(proposedRoute(t.id)!.id)
    flushWrites()
    // The plan step has not finished, so nothing is parked yet.
    expect(approveGate(t.id)).toBeNull()
  })
})

describe('auto-start and gates', () => {
  /**
   * The backlog card in the screenshot: *"plan first, you approve, then build"*, sitting
   * completely still. Planning is cheap, safe, and is the thing that makes the decision
   * possible — so it starts.
   */
  it('starts the plan even though a gate sits after it', () => {
    updateProject(projectId, { autoStart: 'simple' })
    const t = gatedTicket()
    const route = proposedRoute(t.id)!

    expect(routing.maybeAutoStart(route, true)).toBe(true)
    const accepted = acceptedRoute(t.id)!
    expect(accepted.steps[0]!.status).toBe('active')
    // And the build is still pending behind its gate.
    expect(accepted.steps[1]!.status).toBe('pending')
    expect(accepted.steps[1]!.gate).toBe(true)
  })

  it('still refuses everything when auto-start is off', () => {
    updateProject(projectId, { autoStart: 'never' })
    const t = gatedTicket()
    expect(routing.maybeAutoStart(proposedRoute(t.id)!, true)).toBe(false)
  })
})
