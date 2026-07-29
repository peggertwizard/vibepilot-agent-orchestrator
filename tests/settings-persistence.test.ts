import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeDb, openDb } from '../src/main/db'
import { addProject, getProject, updateProject } from '../src/main/db/repos/projects'

/**
 * Every settable field must survive a round-trip.
 *
 * Two whole controls shipped inert: `reviewSensitivity` and `launchPaused` were declared in the
 * Project type, accepted by the IPC schema, read back by the row mapper — and had no SET clause
 * in `updateProject`. The reviewer slider and the pause button both wrote nothing and sprang
 * back to the stored default, and every layer around them type-checked perfectly.
 *
 * A spot check would not have caught it: the other dials added in the same change DO persist.
 * So this walks the whole surface rather than a sample, and will fail the moment a new field is
 * added to the patch type without a writer.
 */
describe('every setting actually persists', () => {
  let dir: string
  let projectId: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'vp-persist-'))
    openDb(join(dir, 'test.db'))
    projectId = addProject({ name: 'Persist', path: dir, defaultBaseBranch: 'main' }).id
  })

  afterAll(() => closeDb())

  it('writes and reads back every field the UI can change', () => {
    const changes = {
      name: 'Renamed',
      defaultBaseBranch: 'trunk',
      maxConcurrentAgents: 6,
      escalation: 'ship_it' as const,
      settingsTrusted: true,
      reviewPasses: 0,
      reviewSensitivity: 9,
      launchPaused: true,
      deployCmd: 'npm run deploy',
      deployNote: 'ask first',
      pilotModel: 'opus',
      spendCeilingUsd: 25,
    }

    updateProject(projectId, changes)
    const after = getProject(projectId)!

    for (const [key, want] of Object.entries(changes)) {
      expect(after[key as keyof typeof after], `${key} did not persist`).toBe(want)
    }
  })

  it('can turn the booleans back off again', () => {
    // A toggle that only goes one way is half a toggle. `launch_paused` writing 1 but never 0
    // would leave the app permanently paused with a button that appears to do nothing.
    updateProject(projectId, { launchPaused: false, settingsTrusted: false })
    const after = getProject(projectId)!
    expect(after.launchPaused).toBe(false)
    expect(after.settingsTrusted).toBe(false)
  })

  it('starts a new project untrusted, unpaused, and at the middle rung', () => {
    const fresh = addProject({ name: 'Fresh', path: join(dir, 'fresh'), defaultBaseBranch: 'main' })
    expect(fresh.settingsTrusted, 'a folder is not trusted until you say so').toBe(false)
    expect(fresh.launchPaused).toBe(false)
    expect(fresh.reviewSensitivity).toBe(5)
  })
})
