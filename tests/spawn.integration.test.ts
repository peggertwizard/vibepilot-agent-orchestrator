import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeDb, openDb } from '../src/main/db'
import { flushWrites } from '../src/main/db/writer'
import { addProject } from '../src/main/db/repos/projects'
import { createAgent, listAgents } from '../src/main/db/repos/agents'
import { createTicket, getTicket, listTickets } from '../src/main/db/repos/tickets'
import { acceptedRoute, proposedRoute } from '../src/main/db/repos/routes'
import { acceptHire, listOpenHires } from '../src/main/db/repos/hires'
import { activeStep } from '../src/shared/types'
import { mcpServer } from '../src/main/mcp/server'
import { callTool } from '../src/main/mcp/tools'
import { manager } from '../src/main/engine/manager'
import { routing } from '../src/main/engine/routing'
import { squashMerge } from '../src/main/git/worktree'
import { bus } from '../src/main/bus'

/**
 * The thing the product exists to do: the Pilot hires a teammate, the teammate does real
 * work in an isolated worktree, and the result merges into main.
 *
 * This drives the MCP tool layer directly rather than through a live Pilot, so it stays
 * under a couple of minutes — the teammate itself is a real Claude process.
 */

const CLAUDE_PRESENT = (() => {
  for (const bin of ['claude', join(process.env['USERPROFILE'] ?? '', '.local', 'bin', 'claude.exe')]) {
    try {
      execFileSync(bin, ['--version'], { windowsHide: true, stdio: 'ignore' })
      return true
    } catch {
      /* try next */
    }
  }
  return false
})()

const d = CLAUDE_PRESENT ? describe : describe.skip

d('spawning a teammate', () => {
  let repo: string
  let projectId: string
  let pilotId: string
  let ticketId: string
  let ticketNumber: number

  beforeAll(async () => {
    openDb(join(mkdtempSync(join(tmpdir(), 'vp-db-')), 'test.db'))

    repo = mkdtempSync(join(tmpdir(), 'vp-repo-'))
    mkdirSync(join(repo, 'src'), { recursive: true })
    writeFileSync(join(repo, 'src', 'greet.js'), 'export function greet() {\n  return "hello"\n}\n')
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
    execFileSync('git', ['add', '-A'], { cwd: repo })
    execFileSync(
      'git',
      ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'initial'],
      { cwd: repo },
    )

    projectId = addProject({ path: repo, name: 'Greet' }).id
    pilotId = createAgent({
      projectId,
      name: 'Pilot',
      role: 'pilot',
      provider: 'claude',
      model: 'sonnet',
      isPilot: true,
    }).id

    const t = createTicket({
      projectId,
      title: 'Add a farewell function',
      body: 'Add an exported `farewell()` to src/greet.js that returns the string "goodbye".',
      lane: 'todo',
    })
    ticketId = t.id
    ticketNumber = t.number

    await mcpServer.listen()
  })

  afterAll(async () => {
    await manager.shutdownAll(5000)
    mcpServer.close()
    flushWrites()
    closeDb()
  })

  it('cannot create a teammate — only propose one', async () => {
    const res = await callTool(
      'suggest_hire',
      { name: 'Dana', role: 'builder', model: 'sonnet', why: 'Somebody has to write this.' },
      { runId: 'r0', agentId: pilotId, projectId, ticketId: null, role: 'pilot' },
    )
    expect(res.structuredContent?.['ok']).toBe(true)
    expect(res.structuredContent?.['status']).toBe('awaiting_confirmation')
    // Nobody exists yet. That is the whole point.
    expect(listAgents(projectId).find((a) => a.name === 'Dana')).toBeUndefined()

    // The user approves, and only then is there a teammate.
    const hire = listOpenHires(projectId)[0]!
    const dana = acceptHire(hire.id)
    expect(dana!.isRoster).toBe(true)
    expect(dana!.ephemeral).toBe(false)
  })

  it('refuses to assign somebody who is not on the roster', async () => {
    const res = await callTool(
      'assign_teammate',
      { agent: 'Ghost', ticket: ticketNumber, brief: 'x' },
      { runId: 'r0', agentId: pilotId, projectId, ticketId: null, role: 'pilot' },
    )
    expect(res.structuredContent?.['ok']).toBe(false)
    expect(String(res.content[0]?.text)).toContain('Nobody on this project is called')
  })

  it('refuses when a non-pilot tries to assign work', async () => {
    const res = await callTool(
      'assign_teammate',
      { agent: 'Dana', ticket: ticketNumber, brief: 'x' },
      { runId: 'r0', agentId: 'someone', projectId, ticketId: null, role: 'builder' },
    )
    expect(res.structuredContent?.['ok']).toBe(false)
    expect(String(res.content[0]?.text)).toContain('Only the Pilot')
  })

  it('refuses to assign onto a ticket that has not been routed', async () => {
    const res = await callTool(
      'assign_teammate',
      { agent: 'Dana', ticket: ticketNumber, brief: 'x' },
      { runId: 'r0', agentId: pilotId, projectId, ticketId: null, role: 'pilot' },
    )
    expect(res.structuredContent?.['ok']).toBe(false)
    expect(String(res.content[0]?.text)).toContain('no accepted route')
  })

  /**
   * The Pilot decides — it just shows you first.
   *
   * This used to assert the opposite: that a confident route "starts without asking". That is
   * how ticket #1 in the real database came to have `auto_accepted: 1` with a teammate already
   * running before anything appeared on screen. Deciding well and acting unannounced are
   * different things, and only the first was ever wanted.
   */
  it('proposes a route and starts NOTHING until the user says so', async () => {
    const res = await callTool(
      'propose_route',
      {
        ticket: ticketNumber,
        steps: [
          {
            kind: 'build',
            note: 'One small exported function; nothing to plan.',
            assignee: 'Dana',
            brief: 'Add an exported farewell() to src/greet.js. Nothing else.',
          },
        ],
        rationale: 'Adding one function to one file.',
        confident: true,
      },
      { runId: 'r0', agentId: pilotId, projectId, ticketId: null, role: 'pilot' },
    )
    expect(res.structuredContent?.['ok']).toBe(true)
    expect(res.structuredContent?.['status']).toBe('awaiting_confirmation')

    // Confident or not, it is a proposal until the user presses Start.
    expect(acceptedRoute(ticketId), 'nothing should be live yet').toBeNull()
    const proposal = proposedRoute(ticketId)!
    expect(proposal, 'there should be a card waiting').toBeTruthy()
    expect(proposal.steps.map((s) => s.kind)).toEqual(['build'])

    // The brief is on the proposal, which is the whole point: it is what the user reads
    // before anything costs anything.
    expect(proposal.steps[0]!.brief).toContain('farewell()')
    expect(proposal.steps[0]!.assigneeAgentId).toBeTruthy()
    expect(getTicket(ticketId)!.stage, 'the board should not have moved').toBeNull()
  })

  it('starts the work when the route is accepted, without a further Pilot turn', () => {
    const proposal = proposedRoute(ticketId)!
    const applied = routing.apply(proposal)

    expect(applied, 'accepting should produce a live route').toBeTruthy()
    expect(acceptedRoute(ticketId)).toBeTruthy()
    // Accepting a route IS starting it — the first step goes active immediately.
    expect(activeStep(applied)!.status).toBe('active')
    // And the board mirrors it without anyone writing `stage` by hand.
    expect(getTicket(ticketId)!.stage).toBe('build')
  })

  it('hires a teammate that does the work in its own worktree, then merges', async () => {
    const done = new Promise<void>((resolve) => {
      const off = bus.onAgent((e) => {
        if (e.agentId !== pilotId && (e.type === 'agent:done' || e.type === 'agent:error')) {
          off()
          resolve()
        }
      })
    })

    const res = await callTool(
      'assign_teammate',
      {
        agent: 'Dana',
        ticket: ticketNumber,
        brief:
          'Add an exported function `farewell()` to src/greet.js returning the string ' +
          '"goodbye". Then commit your change with git. Do not ask any questions.',
      },
      { runId: 'r1', agentId: pilotId, projectId, ticketId: null, role: 'pilot' },
    )

    // Returns immediately — the slow work happens after.
    expect(res.structuredContent?.['ok']).toBe(true)
    expect(res.structuredContent?.['status']).toBe('queued')

    await Promise.race([done, new Promise((r) => setTimeout(r, 240_000))])
    flushWrites()

    const dana = listAgents(projectId).find((a) => a.name === 'Dana')
    expect(dana, 'Dana should exist').toBeDefined()
    expect(dana!.worktreePath, 'she should have been given a worktree').toBeTruthy()
    expect(existsSync(dana!.worktreePath!), 'the worktree should exist on disk').toBe(true)

    // The worktree must be OUTSIDE the project — MAX_PATH on Windows makes nesting fatal.
    expect(dana!.worktreePath!.startsWith(repo)).toBe(false)

    const ticket = getTicket(ticketId)!
    expect(ticket.branch).toBe(`vp/${ticketNumber}-add-a-farewell-function`)
    expect(ticket.assigneeAgentId).toBe(dana!.id)
    // Either it is still on its step or it called advance_step and finished the route. Both
    // are legitimate outcomes for a live model, so assert the INVARIANT instead of guessing:
    // the board's stage is always exactly the route's live step, and null when there is none.
    expect(['in_progress', 'done']).toContain(ticket.lane)
    const route = acceptedRoute(ticketId)!
    expect(ticket.stage).toBe(activeStep(route)?.kind ?? null)
    // The step it worked is recorded against it, not against the ticket at large.
    expect(route.steps[0]!.assigneeAgentId).toBe(dana!.id)

    // The work landed on the branch and NOT on main.
    const mainFile = execFileSync('git', ['show', 'main:src/greet.js'], { cwd: repo }).toString()
    expect(mainFile).not.toContain('farewell')

    const branchFile = execFileSync('git', ['show', `${ticket.branch}:src/greet.js`], {
      cwd: repo,
    }).toString()
    expect(branchFile, 'the teammate should have committed farewell() to its branch').toContain(
      'farewell',
    )

    // And the user can merge it.
    const merged = await squashMerge({
      repo,
      branch: ticket.branch!,
      baseBranch: 'main',
      message: `vp(#${ticketNumber}): ${ticket.title}`,
    })
    expect(merged.ok, 'merge should succeed').toBe(true)

    const afterMerge = execFileSync('git', ['show', 'main:src/greet.js'], { cwd: repo }).toString()
    expect(afterMerge).toContain('farewell')
  })

  it('will not hand the same ticket to a second teammate', async () => {
    const second = createAgent({
      projectId,
      name: 'Second',
      role: 'builder',
      provider: 'claude',
      model: 'sonnet',
      isRoster: true,
    })
    void second
    const res = await callTool(
      'assign_teammate',
      { agent: 'Second', ticket: ticketNumber, brief: 'x' },
      { runId: 'r2', agentId: pilotId, projectId, ticketId: null, role: 'pilot' },
    )
    expect(res.structuredContent?.['ok']).toBe(false)
    expect(String(res.content[0]?.text)).toContain('already with Dana')
    expect(listTickets(projectId)).toHaveLength(1)
  })
})
