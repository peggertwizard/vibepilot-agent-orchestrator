import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeDb, openDb } from '../src/main/db'
import { flushWrites } from '../src/main/db/writer'
import { addProject } from '../src/main/db/repos/projects'
import { createAgent, getAgent } from '../src/main/db/repos/agents'
import { listOpenDrafts, listTickets } from '../src/main/db/repos/tickets'
import { listOpenQuestions } from '../src/main/db/repos/messages'
import { mcpServer } from '../src/main/mcp/server'
import { askUserGate } from '../src/main/mcp/askUser'
import { AlreadyRunningError, manager } from '../src/main/engine/manager'
import type { LaunchSpec } from '../src/main/providers/types'
import { bus } from '../src/main/bus'
import type { AgentEvent } from '../src/shared/events'
import { totalTokens } from '../src/shared/types'

/**
 * The end-to-end proof: a real `claude` process, the real MCP server, the real SQLite
 * schema. If this passes, the orchestration backbone works — everything else is UI.
 *
 * Skips itself when Claude Code isn't installed rather than failing the suite for someone
 * who just wants to run the unit tests.
 */

const CLAUDE_PRESENT = (() => {
  try {
    execFileSync('claude', ['--version'], { windowsHide: true, stdio: 'ignore' })
    return true
  } catch {
    try {
      execFileSync(join(process.env['USERPROFILE'] ?? '', '.local', 'bin', 'claude.exe'), ['--version'], {
        windowsHide: true,
        stdio: 'ignore',
      })
      return true
    } catch {
      return false
    }
  }
})()

const d = CLAUDE_PRESENT ? describe : describe.skip

d('orchestration end to end', () => {
  let repo: string
  let projectId: string
  let agentId: string
  const events: AgentEvent[] = []

  beforeAll(async () => {
    openDb(join(mkdtempSync(join(tmpdir(), 'vp-db-')), 'test.db'))

    repo = mkdtempSync(join(tmpdir(), 'vp-repo-'))
    mkdirSync(join(repo, 'src'), { recursive: true })
    writeFileSync(
      join(repo, 'src', 'cart.js'),
      'export function applyDiscount(total, code) {\n' +
        "  if (code === 'SAVE10') return total * 0.9\n" +
        '  return total\n}\n',
    )
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })

    const project = addProject({ path: repo, name: 'Test Repo' })
    projectId = project.id
    const agent = createAgent({
      projectId,
      name: 'Pilot',
      role: 'pilot',
      provider: 'claude',
      model: 'sonnet',
      isPilot: true,
    })
    agentId = agent.id

    bus.onAgent((e) => events.push(e))
    await mcpServer.listen()
  })

  afterAll(async () => {
    await manager.shutdownAll(4000)
    mcpServer.close()
    flushWrites()
    closeDb()
  })

  async function runTurn(prompt: string, timeoutMs = 150_000): Promise<void> {
    const runId = 'run_' + Math.random().toString(36).slice(2, 8)
    const token = mcpServer.mintToken({
      runId,
      agentId,
      projectId,
      ticketId: null,
      role: 'pilot',
    })

    const spec: LaunchSpec = {
      runId,
      provider: 'claude',
      agentId,
      projectId,
      ticketId: null,
      parentAgentId: null,
      cwd: repo,
      addDirs: [],
      model: 'sonnet',
      appendSystemPrompt:
        'You are a test harness agent. Use the vibePilot tools you are given, immediately, ' +
        'without asking for confirmation. Keep prose to one sentence.',
      permissionMode: 'bypassPermissions',
      allowedTools: ['Read', 'Glob', 'Grep', 'mcp__vibepilot__*'],
      disallowedTools: ['Write', 'Edit', 'MultiEdit'],
      mcp: { url: mcpServer.url, token },
      sessionId: crypto.randomUUID(),
    }

    const run = await manager.launchNow(spec, { text: prompt, channel: 'user' })
    await Promise.race([
      new Promise<void>((resolve) => {
        const off = bus.onAgent((e) => {
          if (e.runId === runId && (e.type === 'agent:done' || e.type === 'agent:error')) {
            off()
            resolve()
          }
        })
      }),
      new Promise((r) => setTimeout(r, timeoutMs)),
    ])
    await run.adapter.stop('test finished', 2000)
    mcpServer.revokeRun(runId)
    flushWrites()
  }

  it('connects the MCP bridge and streams a turn', async () => {
    await runTurn(
      'Read src/cart.js, then call propose_ticket with a title describing the rounding bug ' +
        'in applyDiscount (it returns a float when prices are in cents).',
    )

    const started = events.find((e) => e.type === 'agent:started')
    expect(started, 'agent:started should have been emitted').toBeDefined()
    if (started?.type === 'agent:started') {
      // The single most important assertion in the suite: our tools reached the model.
      expect(started.mcpOk, 'the vibePilot MCP bridge must connect').toBe(true)
      expect(started.tools.some((t) => t.includes('vibepilot'))).toBe(true)
    }

    expect(events.some((e) => e.type === 'agent:tool:start')).toBe(true)
    expect(events.some((e) => e.type === 'agent:cost')).toBe(true)
  })

  it('records real token and context telemetry against the agent', () => {
    const agent = getAgent(agentId)!

    // We launched with the alias "sonnet"; the CLI resolved it to a concrete model. Showing
    // the resolution rather than our guess is what stops the UI claiming models that don't
    // exist — the v1 bug this replaced.
    expect(agent.resolvedModel, 'the alias should have resolved').toBeTruthy()
    expect(agent.resolvedModel).toContain('sonnet')
    expect(agent.model, 'we store the alias, not a pinned id').toBe('sonnet')

    expect(totalTokens(agent), 'tokens should have accumulated').toBeGreaterThan(0)
    expect(agent.tokensOut).toBeGreaterThan(0)

    // Context headroom is what the new meter renders. Unknown before a turn completes.
    expect(agent.contextMax, 'context window should be known').toBeGreaterThan(0)
    expect(agent.contextUsed).toBeGreaterThan(0)
    expect(agent.contextUsed!).toBeLessThanOrEqual(agent.contextMax!)
  })

  /**
   * The runaway-process bug. `byAgent` is keyed by agent id, so a second launch for the same
   * agent used to silently overwrite the first — leaving a process nobody could reach:
   * message_agent could not find it, agents:stop could not stop it, and it kept writing to
   * the same agent row from a different worktree until it finished.
   *
   * Launched with `first: null`, so the process comes up without consuming a turn — this
   * costs a process spawn and no API call.
   */
  it('refuses to give one agent a second process', async () => {
    const runId = 'run_' + Math.random().toString(36).slice(2, 8)
    const token = mcpServer.mintToken({
      runId,
      agentId,
      projectId,
      ticketId: null,
      role: 'pilot',
    })
    const spec: LaunchSpec = {
      runId,
      provider: 'claude',
      agentId,
      projectId,
      ticketId: null,
      parentAgentId: null,
      cwd: repo,
      addDirs: [],
      model: 'haiku',
      appendSystemPrompt: 'idle',
      permissionMode: 'bypassPermissions',
      allowedTools: [],
      disallowedTools: ['Write', 'Edit', 'MultiEdit'],
      mcp: { url: mcpServer.url, token },
      sessionId: crypto.randomUUID(),
    }

    const run = await manager.launchNow(spec, null)
    try {
      expect(manager.forAgent(agentId), 'the first run should be reachable').toBeDefined()

      await expect(
        manager.launchNow({ ...spec, runId: crypto.randomUUID() }, null),
        'a second launch for the same agent must be refused, not silently accepted',
      ).rejects.toThrow(AlreadyRunningError)

      // And the first run is still the one on the books — not replaced by the refused one.
      expect(manager.forAgent(agentId)?.runId).toBe(runId)
    } finally {
      await run.adapter.stop('test finished', 2000)
      mcpServer.revokeRun(runId)
    }
  })

  it('propose_ticket creates a draft, not a ticket', async () => {
    const drafts = listOpenDrafts(projectId)
    expect(drafts.length, 'the model should have proposed a ticket').toBeGreaterThan(0)
    expect(drafts[0]!.title.length).toBeGreaterThan(3)

    // The whole point of the draft flow: nothing is created until the user accepts.
    expect(listTickets(projectId)).toHaveLength(0)
  })

  it('ask_user blocks, then resolves when the user answers', async () => {
    const answered = new Promise<void>((resolve) => {
      const off = bus.onDomain((e) => {
        if (e.type === 'questions:changed') {
          const open = listOpenQuestions(projectId)
          if (open.length > 0) {
            off()
            // Simulate the user clicking an answer in the chat panel.
            setTimeout(() => {
              askUserGate.deliver(open[0]!.id, 'Use integer cents and round half up.')
              resolve()
            }, 300)
          }
        }
      })
    })

    await Promise.all([
      runTurn(
        'Call ask_user asking whether discounts should round up or down, with two choices. ' +
          'Then briefly state the answer you received.',
      ),
      Promise.race([answered, new Promise((r) => setTimeout(r, 120_000))]),
    ])

    const q = listOpenQuestions(projectId)
    expect(q, 'the question should no longer be open once answered').toHaveLength(0)
    expect(events.some((e) => e.type === 'agent:question')).toBe(true)
  })
})
