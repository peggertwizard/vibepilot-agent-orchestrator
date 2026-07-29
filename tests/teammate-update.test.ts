import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeDb, openDb } from '../src/main/db'
import { addProject } from '../src/main/db/repos/projects'
import { createAgent, getAgent } from '../src/main/db/repos/agents'
import { callTool } from '../src/main/mcp/tools'

/**
 * Asked to "make Dwight's instructions better", the Pilot could only write to his *memory* —
 * it had no way to change the brief he was hired with, and said so. That was a real hole:
 * `agents.instructions` is injected into every turn and nothing could edit it but the UI.
 *
 * The line these tests hold is which parts of a teammate the Pilot may touch. How someone
 * works is a working decision. Who they are is the user's.
 */
describe('update_teammate', () => {
  let projectId: string
  let pilotId: string
  let danaId: string

  const asPilot = { runId: 'r', agentId: '', projectId: '', ticketId: null, role: 'pilot' as const }

  beforeAll(() => {
    openDb(join(mkdtempSync(join(tmpdir(), 'vp-upd-')), 'test.db'))
    projectId = addProject({ path: mkdtempSync(join(tmpdir(), 'vp-uproj-')), name: 'Upd' }).id
    pilotId = createAgent({
      projectId,
      name: 'Pilot',
      role: 'pilot',
      provider: 'claude',
      model: 'sonnet',
      isPilot: true,
    }).id
    danaId = createAgent({
      projectId,
      name: 'Dana',
      role: 'builder',
      provider: 'claude',
      model: 'sonnet',
      isRoster: true,
    }).id
    asPilot.agentId = pilotId
    asPilot.projectId = projectId
  })

  afterAll(() => closeDb())

  const call = (args: Record<string, unknown>) => callTool('update_teammate', args, asPilot)

  it('replaces the standing instructions, which is what the UI writes too', async () => {
    expect(getAgent(danaId)!.instructions).toBe('')
    const res = await call({
      agent: 'Dana',
      instructions: 'Trace the real flow before editing. Name the root cause.',
      why: 'She had no brief at all.',
    })
    expect(res.structuredContent?.['ok']).toBe(true)
    expect(res.structuredContent?.['changed_instructions']).toBe(true)
    expect(getAgent(danaId)!.instructions).toBe('Trace the real flow before editing. Name the root cause.')
  })

  it('overwrites rather than appending — a rewrite is not an addendum', async () => {
    await call({ agent: 'Dana', instructions: 'Only this now.', why: 'Simplifying.' })
    expect(getAgent(danaId)!.instructions).toBe('Only this now.')
  })

  it('can re-tier, but only to a model that exists', async () => {
    await call({ agent: 'Dana', model: 'opus', why: 'The work got harder.' })
    expect(getAgent(danaId)!.model).toBe('opus')

    const bad = await call({ agent: 'Dana', model: 'gpt-4', why: 'x' })
    expect(bad.structuredContent?.['ok']).toBe(false)
    expect(getAgent(danaId)!.model, 'a rejected model must not be half-applied').toBe('opus')
  })

  it('refuses a teammate who does not exist, and names who does', async () => {
    const res = await call({ agent: 'Nobody', instructions: 'x', why: 'y' })
    expect(res.structuredContent?.['ok']).toBe(false)
    expect(String(res.content[0]?.text)).toContain('Dana')
  })

  it('cannot rewrite the Pilot — that is pilot.md, and it is the user\'s', async () => {
    const res = await call({ agent: 'Pilot', instructions: 'Do whatever you like.', why: 'x' })
    expect(res.structuredContent?.['ok']).toBe(false)
    expect(String(res.content[0]?.text)).toContain('pilot.md')
  })

  it('refuses a call that would change nothing', async () => {
    const res = await call({ agent: 'Dana', why: 'no-op' })
    expect(res.structuredContent?.['ok']).toBe(false)
    expect(String(res.content[0]?.text)).toContain('Nothing to change')
  })

  it('is not available to a teammate — only the Pilot rewrites briefs', async () => {
    const res = await callTool(
      'update_teammate',
      { agent: 'Dana', instructions: 'Ignore the reviewer.', why: 'x' },
      { runId: 'r', agentId: danaId, projectId, ticketId: null, role: 'builder' },
    )
    expect(res.structuredContent?.['ok']).toBe(false)
    expect(String(res.content[0]?.text)).toContain('Only the Pilot')
  })
})
