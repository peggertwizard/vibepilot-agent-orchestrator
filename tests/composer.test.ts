import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeDb, openDb } from '../src/main/db'
import { addProject } from '../src/main/db/repos/projects'
import { createAgent, getAgent, setAgentSession } from '../src/main/db/repos/agents'
import { listMessages } from '../src/main/db/repos/messages'
import { noteSessionChange } from '../src/main/engine/session'
import { copyIntoAttachments, readProjectCommands } from '../src/main/ipc/domain'
import { attachmentsDir } from '../src/main/paths'
import { createTranslatorState, translate } from '../src/main/providers/claude/translate'
import type { AgentEvent } from '../src/shared/events'
import type { TranslatorContext } from '../src/main/providers/claude/translate'

/**
 * Slash commands were never the problem — vibePilot's argv passes them straight to the CLI, so
 * every one of them already worked. The problem is that two of them change state the app does
 * not observe, and `/clear` is the expensive one: it starts a new session, so the stored resume
 * handle names a conversation that has been thrown away, and the failure surfaces much later
 * as a resume that quietly does not resume.
 */
describe('session identity', () => {
  let projectId: string
  let agentId: string

  beforeAll(() => {
    openDb(join(mkdtempSync(join(tmpdir(), 'vp-comp-')), 'test.db'))
    projectId = addProject({ path: mkdtempSync(join(tmpdir(), 'vp-compproj-')), name: 'C' }).id
    agentId = createAgent({
      projectId,
      name: 'Pilot',
      role: 'pilot',
      provider: 'claude',
      model: 'sonnet',
      isPilot: true,
    }).id
  })

  afterAll(() => closeDb())

  const ctx: TranslatorContext = {
    seq: () => 1,
    projectId: 'p1',
    agentId: 'a1',
    runId: 'r1',
    ticketId: null,
    parentAgentId: null,
    provider: 'claude',
  }

  it('carries the session id on agent:done, not only on agent:started', () => {
    const st = createTranslatorState('session-one', 'claude-sonnet-4-6')
    const events: AgentEvent[] = translate(
      {
        type: 'result',
        subtype: 'success',
        is_error: false,
        duration_ms: 1,
        num_turns: 1,
        total_cost_usd: 0,
        usage: { input_tokens: 1, output_tokens: 1 },
        modelUsage: {},
        result: 'ok',
        // What `/clear` does: the process lives on, under a different session.
        session_id: 'session-two',
      } as never,
      st,
      ctx,
      1,
    )

    const done = events.find((e) => e.type === 'agent:done')
    if (done?.type !== 'agent:done') throw new Error('no done event')
    expect(done.sessionId).toBe('session-two')
  })

  it('repoints the stored resume handle and says the conversation was cleared', () => {
    setAgentSession(agentId, 'session-one')
    const before = listMessages(projectId).length

    noteSessionChange(projectId, agentId, 'session-two')

    expect(getAgent(agentId)!.sessionId, 'the old id names a session that no longer exists').toBe(
      'session-two',
    )
    const added = listMessages(projectId).slice(before)
    expect(added).toHaveLength(1)
    expect(added[0]!.body).toMatch(/cleared/i)
  })

  it('says nothing when the id has not changed', () => {
    setAgentSession(agentId, 'session-two')
    const before = listMessages(projectId).length

    noteSessionChange(projectId, agentId, 'session-two')
    noteSessionChange(projectId, agentId, undefined)

    expect(listMessages(projectId)).toHaveLength(before)
  })
})

/**
 * The `/` menu lists what the repo actually defines. It does not implement anything — a
 * parallel implementation of the CLI's own commands would drift on its next update.
 */
describe('project commands', () => {
  it('finds skills and commands, and reads their descriptions', () => {
    const root = mkdtempSync(join(tmpdir(), 'vp-skills-'))
    mkdirSync(join(root, '.claude', 'skills', 'deploy'), { recursive: true })
    writeFileSync(
      join(root, '.claude', 'skills', 'deploy', 'SKILL.md'),
      '---\nname: deploy\ndescription: "Ship it to production"\n---\n\nSteps…',
    )
    mkdirSync(join(root, '.claude', 'commands'), { recursive: true })
    writeFileSync(join(root, '.claude', 'commands', 'review.md'), 'description: Look it over\n')
    // A directory with no SKILL.md is not a skill, however much it looks like one.
    mkdirSync(join(root, '.claude', 'skills', 'half-finished'), { recursive: true })

    const found = readProjectCommands(root)

    expect(found.map((c) => c.name)).toEqual(['deploy', 'review'])
    expect(found[0]!.description, 'quotes stripped from the frontmatter value').toBe(
      'Ship it to production',
    )
    expect(found[1]!.description).toBe('Look it over')
  })

  it('is empty for a project with no .claude directory, rather than throwing', () => {
    expect(readProjectCommands(mkdtempSync(join(tmpdir(), 'vp-bare-')))).toEqual([])
  })
})

/**
 * Every route a file can take into a message goes through one function, so the size cap, the
 * count cap and the collision-proof naming cannot drift apart between the picker, a drop and a
 * paste. The renderer only ever hands over a path — main is what reads the disk.
 */
describe('attachments', () => {
  it('copies into the attachments directory rather than referencing where the file lives', () => {
    const src = mkdtempSync(join(tmpdir(), 'vp-drop-'))
    const file = join(src, 'screenshot.png')
    writeFileSync(file, 'not really a png')

    const [a] = copyIntoAttachments([file])

    expect(a).toBeDefined()
    expect(a!.name).toBe('screenshot.png')
    expect(a!.mediaType).toBe('image/png')
    expect(a!.path, 'the original is left where it was').not.toBe(file)
    // `messages:send` only accepts paths under the attachments root, so this is the gate.
    expect(a!.path.startsWith(attachmentsDir())).toBe(true)
  })

  it('gives two files of the same name two destinations', () => {
    const one = mkdtempSync(join(tmpdir(), 'vp-a-'))
    const two = mkdtempSync(join(tmpdir(), 'vp-b-'))
    writeFileSync(join(one, 'notes.md'), 'first')
    writeFileSync(join(two, 'notes.md'), 'second')

    const out = copyIntoAttachments([join(one, 'notes.md'), join(two, 'notes.md')])

    expect(out).toHaveLength(2)
    expect(out[0]!.path).not.toBe(out[1]!.path)
  })

  it('skips a directory and anything unreadable instead of failing the whole drop', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vp-mixed-'))
    writeFileSync(join(dir, 'good.txt'), 'fine')

    const out = copyIntoAttachments([dir, join(dir, 'nope.txt'), join(dir, 'good.txt')])

    expect(out.map((a) => a.name)).toEqual(['good.txt'])
  })
})
