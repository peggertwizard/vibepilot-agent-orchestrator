import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeDb, openDb } from '../src/main/db'
import { addProject } from '../src/main/db/repos/projects'
import {
  createAgent,
  deleteAgent,
  findAgentByName,
  getAgent,
  listRoster,
  updateAgent,
} from '../src/main/db/repos/agents'
import { CODEX_LIMITATIONS, MODEL_OPTIONS, ROLE_DEFS, roleDef } from '../src/shared/types'

/**
 * v1 had no way to create a teammate — the Team screen was read-only and no IPC existed.
 * These lock in that the roster is real: created, edited, removed, and that a teammate's
 * instructions are stored rather than decorative.
 */
describe('the team roster', () => {
  let projectId: string

  beforeAll(() => {
    openDb(join(mkdtempSync(join(tmpdir(), 'vp-roster-')), 'test.db'))
    projectId = addProject({ path: mkdtempSync(join(tmpdir(), 'vp-proj-')), name: 'Roster' }).id
  })

  afterAll(() => closeDb())

  it('creates a persistent teammate with instructions', () => {
    const a = createAgent({
      projectId,
      name: 'Dana',
      role: 'specialist',
      provider: 'codex',
      model: 'codex',
      instructions: 'You write all user-facing copy. Never the word "seamless".',
      isRoster: true,
    })

    expect(a.isRoster).toBe(true)
    // Roster members survive their ticket; ephemeral ones do not.
    expect(a.ephemeral).toBe(false)
    expect(a.instructions).toContain('seamless')
    expect(a.avatarInitials).toBe('DA')
    expect(listRoster(projectId)).toHaveLength(1)
  })

  it('finds a teammate by name case-insensitively, so duplicates can be refused', () => {
    expect(findAgentByName(projectId, 'dana')?.name).toBe('Dana')
    expect(findAgentByName(projectId, 'DANA')).toBeTruthy()
    expect(findAgentByName(projectId, 'nobody')).toBeNull()
  })

  it('edits a teammate, including re-deriving the avatar', () => {
    const a = findAgentByName(projectId, 'Dana')!
    const updated = updateAgent(a.id, {
      name: 'Dana Reyes',
      model: 'sonnet',
      provider: 'claude',
      instructions: 'Plain English. No marketing voice.',
    })!

    expect(updated.name).toBe('Dana Reyes')
    expect(updated.avatarInitials).toBe('DR')
    expect(updated.model).toBe('sonnet')
    expect(updated.instructions).toBe('Plain English. No marketing voice.')
    // Editing must not quietly demote a roster member to ephemeral.
    expect(updated.isRoster).toBe(true)
  })

  it('separates the roster from agents spawned for one ticket', () => {
    createAgent({
      projectId,
      name: 'Temp',
      role: 'builder',
      provider: 'claude',
      model: 'sonnet',
    })
    expect(listRoster(projectId).map((a) => a.name)).toEqual(['Dana Reyes'])
    expect(getAgent(findAgentByName(projectId, 'Temp')!.id)!.isRoster).toBe(false)
  })

  it('removes a teammate', () => {
    const a = findAgentByName(projectId, 'Temp')!
    deleteAgent(a.id)
    expect(findAgentByName(projectId, 'Temp')).toBeNull()
  })
})

describe('role definitions', () => {
  it('dropped the v1 per-stage taxonomy', () => {
    // Scout/Planner/Implementer/Reviewer/Tester forced a handoff per stage; each cost a cold
    // start and lost the previous agent's context.
    const ids = ROLE_DEFS.map((r) => r.id)
    expect(ids).toEqual(['builder', 'reviewer', 'scout', 'specialist'])
    expect(ids).not.toContain('planner')
    expect(ids).not.toContain('implementer')
  })

  it('stops read-only roles from editing files', () => {
    for (const id of ['reviewer', 'scout'] as const) {
      expect(roleDef(id)!.denyTools).toContain('Write')
      expect(roleDef(id)!.denyTools).toContain('Edit')
    }
    // A Builder owns the ticket end to end, so it must not be restricted.
    expect(roleDef('builder')!.denyTools).toEqual([])
  })

  it('offers Codex as a provider option', () => {
    const codex = MODEL_OPTIONS.find((m) => m.provider === 'codex')
    expect(codex, 'Codex should be selectable when creating a teammate').toBeDefined()
    expect(codex!.label).toBe('Codex')
  })

  /*
   * What Codex cannot do is still stated — it just lives in CODEX_LIMITATIONS, where each entry
   * is a checked capability fact, rather than in a per-model blurb mixing those facts in with
   * opinions about which model is nicer to use.
   */
  it('still says plainly what a Codex teammate cannot do', () => {
    expect(CODEX_LIMITATIONS.join(' ')).toMatch(/no live streaming/)
    expect(CODEX_LIMITATIONS.join(' ')).toMatch(/no sub-agents/)
  })
})
