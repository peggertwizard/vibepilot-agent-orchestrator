import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeDb, openDb } from '../src/main/db'
import { flushWrites } from '../src/main/db/writer'
import { addProject } from '../src/main/db/repos/projects'
import { createDraft, getDraft, listOpenDrafts, resolveDraft } from '../src/main/db/repos/tickets'
import { liveBoardBlock } from '../src/main/engine/context'

/**
 * A correction is not a rejection.
 *
 * The user typed what to change about a proposed ticket, and the app produced a *second* card
 * beside the first, because a draft could only end by being accepted, parked or rejected —
 * there was no way to say "this is the new version of that". The only way to clear the stale
 * card was Discard, which told the Pilot the user had turned the idea down. Twice in a row it
 * concluded it was guessing wrong and stopped proposing: *"Zwei Ablehnungen hintereinander
 * heißt, ich rate falsch. Ich höre auf zu raten."*
 *
 * Nothing had been rejected. The app said so on the user's behalf.
 */
let projectId: string

beforeAll(() => {
  openDb(join(mkdtempSync(join(tmpdir(), 'vp-db-')), 'test.db'))
  const repo = mkdtempSync(join(tmpdir(), 'vp-repo-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  projectId = addProject({ path: repo, name: 'Drafts' }).id
})

afterAll(() => {
  flushWrites()
  closeDb()
})

const draft = (title: string): string =>
  createDraft({
    projectId,
    proposedByAgentId: null,
    title,
    body: 'body',
    lane: 'todo',
    needsPlanning: false,
    ownerHint: null,
    sizeNote: null,
    dependsOn: [],
  }).id

describe('a draft that was revised rather than refused', () => {
  it('accepts the superseded status the schema used to forbid', () => {
    const id = draft('First attempt')
    resolveDraft(id, 'superseded')
    expect(getDraft(id)?.status).toBe('superseded')
  })

  it('takes the old card off the screen', () => {
    const old = draft('Wrong wording')
    const fresh = draft('Right wording')
    resolveDraft(old, 'superseded')

    const open = listOpenDrafts(projectId).map((d) => d.id)
    expect(open).not.toContain(old)
    expect(open).toContain(fresh)
  })

  /** Distinct from rejection, because the two produce opposite instructions to the Pilot. */
  it('is not the same ending as being turned down', () => {
    const a = draft('Superseded one')
    const b = draft('Rejected one')
    resolveDraft(a, 'superseded')
    resolveDraft(b, 'rejected')
    expect(getDraft(a)?.status).toBe('superseded')
    expect(getDraft(b)?.status).toBe('rejected')
  })
})

/**
 * The board the Pilot reasons about, on the turn it reasons.
 *
 * `buildPilotPrompt` runs once at spawn, so the board it carries is the board as it was when
 * the conversation started. By the fifth message the Pilot is working from stale state — which
 * is how it came to write *"Board-Stand liegt nicht auf der Platte, aber es kann nur der
 * ColorZilla-Entwurf sein — also #4"*: a ticket number reached by elimination.
 */
describe('the board block sent with every user turn', () => {
  it('lists pending drafts with the id `replaces` needs', () => {
    const id = draft('Needs an id in front of the Pilot')
    const block = liveBoardBlock({
      tickets: [],
      routes: [],
      drafts: [{ id, title: 'Needs an id in front of the Pilot' }],
    })
    expect(block).toContain(id)
    expect(block).toContain('replaces')
    // And says whose job it is to clear the old card.
    expect(block).toMatch(/not ask the user to discard/i)
  })

  it('says nothing about drafts when there are none', () => {
    const block = liveBoardBlock({ tickets: [], routes: [], drafts: [] })
    expect(block).not.toMatch(/Drafts you have shown/i)
    expect(block).not.toMatch(/propose_ticket/)
    expect(block).toContain('<vibepilot-board>')
  })

  /** It must be unmistakably the current one, or it is just more context to weigh. */
  it('says it supersedes anything older', () => {
    expect(liveBoardBlock({ tickets: [], routes: [], drafts: [] })).toMatch(/replaces anything older/i)
  })
})
