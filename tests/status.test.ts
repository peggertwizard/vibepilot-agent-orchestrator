import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeDb, openDb } from '../src/main/db'
import { addProject } from '../src/main/db/repos/projects'
import { createAgent, getAgent } from '../src/main/db/repos/agents'
import { callTool, publicToolDefs } from '../src/main/mcp/tools'
import { summariseTool } from '../src/main/engine/status'

/**
 * The status line was the name of the last tool called. Literally `bash` — a debug readout in
 * the one place a person looks to find out what is happening, and it stuck there, because once
 * the Pilot delegates it has nothing to do and whatever it touched last stays on screen for as
 * long as the teammate runs.
 *
 * Nothing can turn a command line into intent without guessing. The Pilot knows; it is asked.
 */
describe('status', () => {
  let projectId: string
  let pilotId: string
  let builderId: string

  beforeAll(() => {
    openDb(join(mkdtempSync(join(tmpdir(), 'vp-status-')), 'test.db'))
    projectId = addProject({ path: mkdtempSync(join(tmpdir(), 'vp-stproj-')), name: 'S' }).id
    pilotId = createAgent({
      projectId,
      name: 'Pilot',
      role: 'pilot',
      provider: 'claude',
      model: 'sonnet',
      isPilot: true,
    }).id
    builderId = createAgent({
      projectId,
      name: 'Sam',
      role: 'builder',
      provider: 'claude',
      model: 'sonnet',
    }).id
  })

  afterAll(() => closeDb())

  it('puts the sentence the Pilot wrote on its row', async () => {
    const res = await callTool(
      'status',
      { one_line: 'Reading the routing code to see what a review step costs' },
      { runId: 'r', agentId: pilotId, projectId, ticketId: null, role: 'pilot' },
    )

    expect(res.structuredContent?.['ok']).toBe(true)
    expect(getAgent(pilotId)!.statusLine).toBe(
      'Reading the routing code to see what a review step costs',
    )
  })

  it('is offered to the Pilot and not to teammates', () => {
    expect(publicToolDefs('pilot').map((t) => t.name)).toContain('status')
    // A teammate's line is its last tool, which is the right thing in the watch drawer. A tool
    // whose effect the next tool call wipes out is worse than no tool.
    expect(publicToolDefs('builder').map((t) => t.name)).not.toContain('status')
  })

  it('refuses a teammate that calls it anyway', async () => {
    const before = getAgent(builderId)!.statusLine
    const res = await callTool(
      'status',
      { one_line: 'trying it on' },
      { runId: 'r', agentId: builderId, projectId, ticketId: null, role: 'builder' },
    )

    expect(res.structuredContent?.['ok']).toBe(false)
    expect(getAgent(builderId)!.statusLine).toBe(before)
  })

  it('still reads tool calls in plain words for the drawer', () => {
    // This is what teammates keep, and what the Pilot no longer uses for its status line.
    expect(summariseTool('Bash')).toBe('ran a command')
    expect(summariseTool('Read', { filenames: ['src/main/bus.ts'], numLines: 240 })).toBe(
      'read bus.ts (240 lines)',
    )
  })
})
