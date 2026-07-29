import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeDb, openDb } from '../src/main/db'
import { addProject, getProject, updateProject } from '../src/main/db/repos/projects'
import { createAgent } from '../src/main/db/repos/agents'
import {
  addQuestion,
  getQuestion,
  listOpenQuestions,
  markQuestionAskedPilot,
  openQuestionCounts,
  orphanQuestionsForAgent,
} from '../src/main/db/repos/messages'
import { callTool } from '../src/main/mcp/tools'
import { askUserGate } from '../src/main/mcp/askUser'
import { buildClaudeArgv } from '../src/main/providers/claude/argv'
import type { LaunchSpec } from '../src/main/providers/types'
import { DEFAULT_ESCALATION, escalationRule, isValidEscalation } from '../src/shared/types'

/**
 * Questions, and who answers them.
 *
 * Three separate failures lived here, and the order matters: the transport gave up before the
 * wait did, a dead agent left a card whose answer went nowhere, and nobody was ever told a
 * question existed. A routing ladder built on any of those is a ladder on sand.
 */
describe('questions', () => {
  let projectId: string
  let pilotId: string
  let builderId: string

  beforeAll(() => {
    openDb(join(mkdtempSync(join(tmpdir(), 'vp-q-')), 'test.db'))
    projectId = addProject({ path: mkdtempSync(join(tmpdir(), 'vp-qproj-')), name: 'Q' }).id
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
      name: 'Dana',
      role: 'builder',
      provider: 'claude',
      model: 'sonnet',
    }).id
  })

  afterAll(() => closeDb())

  const ask = (question: string, urgency: 'blocking' | 'background' = 'blocking') =>
    addQuestion({ projectId, agentId: builderId, question, urgency })

  const asPilot = (name: string, args: Record<string, unknown>) =>
    callTool(name, args, {
      runId: 'r-pilot',
      agentId: pilotId,
      projectId,
      ticketId: null,
      role: 'pilot',
    })

  /* ── the transport ───────────────────────────────────────────────────────── */

  it('gives the vibepilot MCP server a timeout far above the 60s default', () => {
    const spec: LaunchSpec = {
      runId: 'r1',
      provider: 'claude',
      agentId: 'a1',
      projectId: 'p1',
      ticketId: null,
      parentAgentId: null,
      cwd: process.cwd(),
      addDirs: [],
      model: 'sonnet',
      appendSystemPrompt: '',
      permissionMode: 'bypassPermissions',
      mcp: { url: 'http://127.0.0.1:1/mcp', token: 't' },
      sessionId: '11111111-1111-1111-1111-111111111111',
    }
    const args = buildClaudeArgv(spec)
    const cfg = JSON.parse(args[args.indexOf('--mcp-config') + 1]!)
    const server = cfg.mcpServers.vibepilot

    // Under the CLI's 60s default, every answer that took a human more than a minute died at
    // the protocol layer — which is most of them.
    expect(server.timeout).toBeGreaterThan(60_000)
    // The CLI ignores anything below a second, so a plausible-looking small number is a trap.
    expect(server.timeout).toBeGreaterThanOrEqual(1000)
    // Scoped to our server, so nothing the user configured elsewhere changes.
    expect(Object.keys(cfg.mcpServers)).toEqual(['vibepilot'])
  })

  /* ── zombie cards ────────────────────────────────────────────────────────── */

  it('closes an agent\'s open questions when its process ends', () => {
    const q = ask('Which locale file?')
    expect(listOpenQuestions(projectId).some((x) => x.id === q.id)).toBe(true)

    const closed = orphanQuestionsForAgent(builderId)

    expect(closed).toBe(1)
    expect(getQuestion(q.id)!.status).toBe('orphaned')
    // The card is gone, so you cannot answer into a void any more.
    expect(listOpenQuestions(projectId).some((x) => x.id === q.id)).toBe(false)
  })

  it('refuses to deliver an answer to a question that is no longer open', () => {
    const q = ask('Dead already?')
    orphanQuestionsForAgent(builderId)

    expect(askUserGate.deliver(q.id, 'too late')).toBe(false)
    expect(getQuestion(q.id)!.answer).toBeNull()
  })

  /* ── the doorbell ────────────────────────────────────────────────────────── */

  it('counts open questions per project, including ones you are not looking at', () => {
    const other = addProject({ path: mkdtempSync(join(tmpdir(), 'vp-qp2-')), name: 'Elsewhere' })
    const stranger = createAgent({
      projectId: other.id,
      name: 'Sam',
      role: 'builder',
      provider: 'claude',
      model: 'sonnet',
    })
    addQuestion({ projectId: other.id, agentId: stranger.id, question: 'Over here?' })

    expect(openQuestionCounts()[other.id]).toBe(1)

    orphanQuestionsForAgent(stranger.id)
    expect(openQuestionCounts()[other.id]).toBeUndefined()
  })

  /* ── the ladder ──────────────────────────────────────────────────────────── */

  it('keeps the question open when it is handed to the Pilot', () => {
    const q = ask('Tabs or spaces?')
    markQuestionAskedPilot(q.id)

    const after = getQuestion(q.id)!
    expect(after.pilotAskedAt).toBeGreaterThan(0)
    // Delegating must not take it away from you: same row, same id, still answerable.
    expect(after.status).toBe('open')
    expect(listOpenQuestions(projectId).some((x) => x.id === q.id)).toBe(true)

    orphanQuestionsForAgent(builderId)
  })

  it('lets the Pilot answer on your behalf, and says so to the asker', async () => {
    const q = ask('Which colour for the badge?')

    const res = await asPilot('answer_question', { question_id: q.id, answer: 'The accent.' })
    expect(res.structuredContent?.['ok']).toBe(true)

    const after = getQuestion(q.id)!
    expect(after.status).toBe('answered')
    expect(after.answer).toBe('The accent.')
    // The distinction the teammate reads: nobody human has seen this.
    expect(after.answeredBy).toBe('pilot')
  })

  it('first writer wins, and the loser is a harmless no-op', () => {
    const q = ask('Who gets there first?')

    expect(askUserGate.deliver(q.id, 'the user did', 'user')).toBe(false) // nobody waiting
    expect(getQuestion(q.id)!.answer).toBe('the user did')

    // The Pilot's later call finds it closed and changes nothing — no lock, no timer, no
    // take-it-back button needed.
    expect(askUserGate.deliver(q.id, 'the pilot did', 'pilot')).toBe(false)
    const after = getQuestion(q.id)!
    expect(after.answer).toBe('the user did')
    expect(after.answeredBy).toBe('user')
  })

  it('will not answer twice, and says which way it went', async () => {
    const q = ask('Already settled?')
    askUserGate.deliver(q.id, 'I said so', 'user')

    const res = await asPilot('answer_question', { question_id: q.id, answer: 'no, this' })
    expect(res.structuredContent?.['ok']).toBe(false)
    expect(String(res.content[0]!.text)).toMatch(/user answered that one themselves/i)
    expect(getQuestion(q.id)!.answer).toBe('I said so')
  })

  it('requires the Pilot to say what it checked before escalating', async () => {
    const q = ask('Should this ship on Friday?')

    await expect(asPilot('escalate_question', { question_id: q.id })).rejects.toThrow()

    const res = await asPilot('escalate_question', {
      question_id: q.id,
      what_i_checked: 'The ticket, the release notes and the deploy rule in CLAUDE.md.',
    })
    expect(res.structuredContent?.['ok']).toBe(true)
    // Escalation hands it back — it does not close it. The teammate is still parked on this id.
    expect(getQuestion(q.id)!.status).toBe('open')

    orphanQuestionsForAgent(builderId)
  })

  it('only the Pilot may answer or escalate', async () => {
    const q = ask('Can a builder answer for the user?')
    const res = await callTool(
      'answer_question',
      { question_id: q.id, answer: 'sure' },
      { runId: 'r', agentId: builderId, projectId, ticketId: null, role: 'builder' },
    )
    expect(res.structuredContent?.['ok']).toBe(false)
    expect(getQuestion(q.id)!.status).toBe('open')

    orphanQuestionsForAgent(builderId)
  })

  /* ── the dial ────────────────────────────────────────────────────────────── */

  it('defaults to balanced and stores what you choose', () => {
    expect(getProject(projectId)!.escalation).toBe(DEFAULT_ESCALATION)

    updateProject(projectId, { escalation: 'ask_me' })
    expect(getProject(projectId)!.escalation).toBe('ask_me')
  })

  it('at "ask me" the Pilot is refused and told to escalate instead', async () => {
    updateProject(projectId, { escalation: 'ask_me' })
    const q = ask('Do we drop the old endpoint?')

    const res = await asPilot('answer_question', { question_id: q.id, answer: 'yes, drop it' })

    expect(res.structuredContent?.['ok']).toBe(false)
    expect(String(res.content[0]!.text)).toMatch(/escalate_question/)
    expect(getQuestion(q.id)!.status).toBe('open')

    updateProject(projectId, { escalation: 'balanced' })
    orphanQuestionsForAgent(builderId)
  })

  it('gives the Pilot and a teammate different instructions from the same dial', () => {
    for (const level of ['ask_me', 'balanced', 'ship_it'] as const) {
      const forPilot = escalationRule(level, true)
      const forTeammate = escalationRule(level, false)
      expect(forPilot).not.toBe(forTeammate)
      expect(forPilot.length).toBeGreaterThan(40)
      expect(forTeammate.length).toBeGreaterThan(40)
    }
    // The Pilot is told not to answer; the teammate is told to ask.
    expect(escalationRule('ask_me', true)).toMatch(/escalate_question/)
    expect(escalationRule('ship_it', false)).toMatch(/Do not block/i)
    expect(isValidEscalation('balanced')).toBe(true)
    expect(isValidEscalation('whenever')).toBe(false)
  })

  /* ── background questions ────────────────────────────────────────────────── */

  it('a background question records and returns, instead of parking the agent', async () => {
    const q = ask('Nice-to-know: is there a changelog convention?', 'background')

    const started = Date.now()
    const res = await askUserGate.wait(q.id, {
      runId: 'r-bg',
      agentId: builderId,
      projectId,
      ticketId: null,
      role: 'builder',
    })

    // The field has been in the schema since day one and blocked anyway. It must not block now.
    expect(Date.now() - started).toBeLessThan(2000)
    expect(res.structuredContent?.['status']).toBe('pending')
    expect(String(res.content[0]!.text)).toMatch(/carry on/i)
    expect(getQuestion(q.id)!.status).toBe('open')

    orphanQuestionsForAgent(builderId)
  })
})
