import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeDb, openDb } from '../src/main/db'
import { addProject } from '../src/main/db/repos/projects'
import { createAgent, listRoster } from '../src/main/db/repos/agents'
import { acceptHire, listOpenHires, proposeHire, rejectHire } from '../src/main/db/repos/hires'
import { extractJson } from '../src/main/engine/bootstrap'

/**
 * The Pilot used to conjure teammates with spawn_agent, one per ticket, gone afterwards —
 * which is why the team felt like "empty shells". Hiring is now the user's decision, and a
 * proposal is a real persisted object so the card survives a restart while they think.
 */
describe('hiring', () => {
  let projectId: string

  beforeAll(() => {
    openDb(join(mkdtempSync(join(tmpdir(), 'vp-hire-')), 'test.db'))
    projectId = addProject({ path: mkdtempSync(join(tmpdir(), 'vp-hproj-')), name: 'Hire' }).id
  })

  afterAll(() => closeDb())

  it('a proposal creates nobody until it is accepted', () => {
    const h = proposeHire({
      projectId,
      proposedByAgentId: null,
      name: 'Dana',
      role: 'builder',
      model: 'sonnet',
      why: 'Most of this is TypeScript feature work.',
    })
    expect(listRoster(projectId)).toHaveLength(0)
    expect(listOpenHires(projectId).map((x) => x.id)).toEqual([h.id])

    const a = acceptHire(h.id)!
    expect(a.name).toBe('Dana')
    expect(a.isRoster, 'a hire persists across tickets').toBe(true)
    expect(a.ephemeral).toBe(false)
    expect(listOpenHires(projectId), 'the card is resolved, not left hanging').toHaveLength(0)
  })

  it('the user can rename and re-tier before approving', () => {
    const h = proposeHire({
      projectId,
      proposedByAgentId: null,
      name: 'Reviewer1',
      role: 'reviewer',
      model: 'opus',
      why: 'Visual work needs a second pair of eyes.',
      instructions: 'Read as someone who did not write it.',
    })
    const a = acceptHire(h.id, { name: 'Rae', model: 'sonnet' })!
    expect(a.name).toBe('Rae')
    expect(a.model, 'the user is the one paying the rate limit').toBe('sonnet')
    expect(a.instructions).toBe('Read as someone who did not write it.')
  })

  it('accepting cannot create a duplicate name', () => {
    createAgent({ projectId, name: 'Taken', role: 'builder', provider: 'claude', model: 'sonnet', isRoster: true })
    const h = proposeHire({
      projectId,
      proposedByAgentId: null,
      name: 'Taken',
      role: 'builder',
      model: 'sonnet',
      why: 'x',
    })
    expect(acceptHire(h.id)).toBeNull()
    expect(listOpenHires(projectId).some((x) => x.id === h.id), 'it stays open to be renamed').toBe(true)
  })

  it('a rejected proposal cannot be accepted afterwards', () => {
    const h = proposeHire({
      projectId,
      proposedByAgentId: null,
      name: 'Nope',
      role: 'scout',
      model: 'haiku',
      why: 'x',
    })
    rejectHire(h.id)
    expect(acceptHire(h.id)).toBeNull()
    expect(listRoster(projectId).some((a) => a.name === 'Nope')).toBe(false)
  })

  describe('the bootstrap scan reads what the model actually replies', () => {
    it('pulls JSON out of a reply wrapped in prose and a fence', () => {
      const out = extractJson(
        'Sure! Here is the team I would suggest:\n\n```json\n' +
          '{"summary":"A Vite app.","team":[{"name":"Dana","role":"builder","model":"sonnet","why":"TS"}]}\n' +
          '```\n\nLet me know if you want changes.',
      )
      expect(out?.team?.[0]?.name).toBe('Dana')
      expect(out?.summary).toBe('A Vite app.')
    })

    it('is not fooled by braces inside strings', () => {
      const out = extractJson('{"summary":"uses {curly} braces","team":[]}')
      expect(out?.summary).toBe('uses {curly} braces')
    })

    it('returns null rather than throwing on rubbish', () => {
      expect(extractJson('I could not read this repository.')).toBeNull()
      expect(extractJson('{"team": [oops}')).toBeNull()
      expect(extractJson('')).toBeNull()
    })
  })
})
