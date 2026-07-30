import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeDb, openDb } from '../src/main/db'
import { flushWrites } from '../src/main/db/writer'
import { addProject, updateProject } from '../src/main/db/repos/projects'
import { createAgent } from '../src/main/db/repos/agents'
import { createTicket, getTicket } from '../src/main/db/repos/tickets'
import { proposedRoute } from '../src/main/db/repos/routes'
import { acceptHire, listOpenHires } from '../src/main/db/repos/hires'
import { mcpServer } from '../src/main/mcp/server'
import { callTool } from '../src/main/mcp/tools'
import { manager } from '../src/main/engine/manager'
import { routing } from '../src/main/engine/routing'

/**
 * `extend_ticket` against a live agent.
 *
 * It shipped in 0.1.6, typechecked, with no tests and never once exercised — which mattered
 * because it is the answer to the thing that actually went wrong: asked for a word change
 * while a teammate was working, the Pilot's only vocabulary was `propose_ticket`, so a
 * one-word change became a card, an agent, a reviewer and a branch that collided with two
 * others on the same file.
 *
 * What is asserted here is the whole claim: the body grows, the running teammate is told
 * without being interrupted, and **no second ticket appears**.
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

d('extending a ticket that is already being worked', () => {
  let repo: string
  let projectId: string
  let pilotId: string
  let ticketId: string
  let ticketNumber: number

  const pilot = (): {
    runId: string
    agentId: string
    projectId: string
    ticketId: null
    role: 'pilot'
  } => ({ runId: 'r0', agentId: pilotId, projectId, ticketId: null, role: 'pilot' })

  beforeAll(async () => {
    openDb(join(mkdtempSync(join(tmpdir(), 'vp-db-')), 'test.db'))

    repo = mkdtempSync(join(tmpdir(), 'vp-repo-'))
    mkdirSync(join(repo, 'src'), { recursive: true })
    // One file, so a second ticket on it would be exactly the collision this prevents.
    writeFileSync(join(repo, 'src', 'prices.js'), 'export const storage = "10 GB"\n')
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
    execFileSync('git', ['add', '-A'], { cwd: repo })
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'initial'], {
      cwd: repo,
    })

    projectId = addProject({ path: repo, name: 'Prices' }).id
    /*
     * Auto-start off. This file is about `extend_ticket` reaching a live agent, and it drives
     * the route lifecycle by hand to get one running. With auto-start on, `propose_route`
     * accepts the route itself and there is no proposal left for the test to apply.
     */
    updateProject(projectId, { autoStart: 'never' })
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
      title: 'Rename the storage constant',
      body: 'In src/prices.js, rename the exported `storage` constant to `emailStorage`.',
      lane: 'todo',
    })
    ticketId = t.id
    ticketNumber = t.number

    await mcpServer.listen()
  }, 60_000)

  afterAll(async () => {
    await manager.shutdownAll(5000)
    mcpServer.close()
    flushWrites()
    closeDb()
  })

  it('refuses to extend a ticket that does not exist', async () => {
    const res = await callTool('extend_ticket', { ticket: 999, addition: 'x' }, pilot())
    expect(res.structuredContent?.['ok']).toBe(false)
    expect(String(res.content[0]?.text)).toContain('no ticket #999')
  })

  it('appends to a ticket nobody is working on, without inventing a second one', async () => {
    const before = getTicket(ticketId)!.body
    const res = await callTool(
      'extend_ticket',
      { ticket: ticketNumber, addition: 'Also change the value from 10 GB to 5 GB.' },
      pilot(),
    )

    expect(res.structuredContent?.['ok']).toBe(true)
    const after = getTicket(ticketId)!
    // Appended, never replaced: the original wording is what a reviewer checks against.
    expect(after.body.startsWith(before)).toBe(true)
    expect(after.body).toContain('**Also:**')
    expect(after.body).toContain('10 GB to 5 GB')
    // Nobody is on it, so it says so rather than claiming someone was told.
    expect(String(res.content[0]?.text)).toContain('Nobody is working on it')
  })

  it('reaches a teammate that is actually running, and creates no new ticket', async () => {
    // Hire, route, start — the ordinary path, so the assertion is about the real thing.
    await callTool(
      'suggest_hire',
      { name: 'Robin', role: 'builder', model: 'sonnet', why: 'Someone has to do it.' },
      pilot(),
    )
    acceptHire(listOpenHires(projectId)[0]!.id)

    await callTool(
      'propose_route',
      {
        ticket: ticketNumber,
        steps: [
          {
            kind: 'build',
            assignee: 'Robin',
            brief:
              'Rename the exported `storage` constant in src/prices.js to `emailStorage`. ' +
              'Commit the change. Do not do anything else.',
          },
        ],
        rationale: 'One small rename.',
      },
      pilot(),
    )

    const route = proposedRoute(ticketId)
    expect(route).not.toBeNull()
    routing.apply(route!)

    // Give the process a moment to exist. Extending before it is up would test the other path.
    const robin = (await import('../src/main/db/repos/agents')).findAgentByName(projectId, 'Robin')!
    for (let i = 0; i < 60 && !manager.forAgent(robin.id); i++) {
      await new Promise((r) => setTimeout(r, 500))
    }
    expect(manager.forAgent(robin.id)).toBeTruthy()

    const bodyBefore = getTicket(ticketId)!.body
    const res = await callTool(
      'extend_ticket',
      { ticket: ticketNumber, addition: 'Also add a trailing newline comment saying // prices.' },
      pilot(),
    )

    expect(res.structuredContent?.['ok']).toBe(true)
    // The claim that has never been checked: it went to the person, not to a new card.
    expect(String(res.content[0]?.text)).toContain('Robin')
    expect(String(res.content[0]?.text)).toContain('do not create a ticket')

    const after = getTicket(ticketId)!
    expect(after.body.startsWith(bodyBefore)).toBe(true)
    expect(after.body).toContain('// prices')

    // Still one ticket. The entire point.
    const { listTickets } = await import('../src/main/db/repos/tickets')
    expect(listTickets(projectId)).toHaveLength(1)
  }, 180_000)
})
