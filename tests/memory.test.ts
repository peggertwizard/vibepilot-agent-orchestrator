import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeDb, openDb, run } from '../src/main/db'
import { addProject } from '../src/main/db/repos/projects'
import {
  listMemory,
  recall,
  recordFeedback,
  remember,
  renderForPrompt,
  syncMemory,
} from '../src/main/memory'
import { ensureMemoryDirs, memoryDir, parseMemoryFile } from '../src/main/memory/store'

/**
 * The claim this design makes is that the markdown files are the source of truth and SQLite
 * is a disposable index. These tests are what stops that claim from quietly becoming
 * marketing: the index is deleted and rebuilt, and recall must come back identical.
 */
describe('memory', () => {
  let projectId: string
  let projectPath: string

  beforeAll(() => {
    openDb(join(mkdtempSync(join(tmpdir(), 'vp-mem-')), 'test.db'))
    projectPath = mkdtempSync(join(tmpdir(), 'vp-memproj-'))
    projectId = addProject({ path: projectPath, name: 'Memory' }).id
    ensureMemoryDirs(projectPath)
  })

  afterAll(() => closeDb())

  it('writes to a markdown file a human can read', () => {
    const out = remember({
      projectId,
      projectPath,
      category: 'gotcha',
      title: 'node:sqlite is absent from module.builtinModules',
      body: 'It is isBuiltin() true but missing from the list, so bundlers try to bundle it.',
      author: 'Dana',
      concerns: ['src/main/db/index.ts'],
    })

    expect(out.file).toBe('project/gotchas.md')
    const text = readFileSync(join(memoryDir(projectPath), out.file), 'utf8')
    expect(text).toContain('## node:sqlite is absent from module.builtinModules')
    expect(text).toContain('source=agent')
    expect(text).toContain('author=Dana')
    expect(text).toContain('files=src/main/db/index.ts')
  })

  it('re-remembering the same title updates rather than duplicating', () => {
    remember({
      projectId,
      projectPath,
      category: 'convention',
      title: 'Commit messages',
      body: 'First wording.',
      author: 'Dana',
    })
    remember({
      projectId,
      projectPath,
      category: 'convention',
      title: 'Commit messages',
      body: 'Better wording: vp(#12): what changed.',
      author: 'Dana',
    })
    const hits = listMemory(projectId).filter((e) => e.title === 'Commit messages')
    expect(hits).toHaveLength(1)
    expect(hits[0]!.body).toContain('Better wording')
  })

  it('finds things by meaning of the words, not exact phrase', () => {
    const hits = recall(projectId, 'why does the sqlite driver fail to bundle')
    expect(hits.map((h) => h.title)).toContain('node:sqlite is absent from module.builtinModules')
  })

  it('THE INDEX IS DISPOSABLE — delete it and recall comes back identical', () => {
    const query = 'sqlite bundler commit convention'
    const before = recall(projectId, query, { limit: 10 }).map((e) => e.id)
    expect(before.length).toBeGreaterThan(0)

    // Nuke every row. If the files are really the truth, this loses nothing.
    run('DELETE FROM memory_entries WHERE project_id = ?', projectId)
    expect(listMemory(projectId)).toHaveLength(0)

    const n = syncMemory(projectId, projectPath)
    expect(n).toBeGreaterThan(0)

    const after = recall(projectId, query, { limit: 10 }).map((e) => e.id)
    expect(after, 'same entries, same order, same ids').toEqual(before)
  })

  it('an entry typed by hand, with no provenance comment, still indexes', () => {
    const p = join(memoryDir(projectPath), 'project/decisions.md')
    writeFileSync(
      p,
      '# Decisions\n\n## We spawn the CLI rather than use the Agent SDK\n\n' +
        'The SDK is not permitted with a subscription. See docs/architecture/auth.md.\n',
      'utf8',
    )
    syncMemory(projectId, projectPath)

    const hit = listMemory(projectId).find((e) => e.title.startsWith('We spawn the CLI'))
    expect(hit, 'a hand-written entry is a first-class entry').toBeTruthy()
    expect(hit!.source).toBe('agent')
    expect(hit!.category).toBe('decision')
  })

  it('user feedback lands in that teammate\'s own file and outranks everything', () => {
    const out = recordFeedback({
      projectId,
      projectPath,
      agentName: 'Dana',
      lesson: 'Keep button labels to one word. The user found "Submit your details" fussy.',
    })
    expect(out.file).toBe('agents/dana.md')

    const text = readFileSync(join(memoryDir(projectPath), out.file), 'utf8')
    expect(text).toContain('source=user')
    expect(text).toContain('author=the_user')

    syncMemory(projectId, projectPath)
    const entry = listMemory(projectId).find((e) => e.agentScope === 'dana')!
    expect(entry.source).toBe('user')
    expect(entry.category).toBe('lesson')

    // And it is loaded for Dana whatever the query — she will not think to search for it.
    const own = recall(projectId, 'unrelated query about database migrations', {
      agentScope: 'dana',
    })
    expect(own.map((e) => e.id)).toContain(entry.id)
  })

  it('one teammate can read another\'s memory — it just is not preloaded', () => {
    const hits = recall(projectId, 'button labels', { onlyScope: 'dana' })
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.every((h) => h.agentScope === 'dana')).toBe(true)
  })

  it('a hostile query cannot crash FTS mid-spawn', () => {
    // A ticket title containing quotes or FTS operators used to be a syntax error, which
    // would have taken down the agent that was being spawned.
    for (const q of ['"', 'AND OR NOT', 'foo NEAR/2 "bar', '((((', '*', '']) {
      expect(() => recall(projectId, q)).not.toThrow()
    }
  })

  it('renders for a prompt with its provenance attached', () => {
    const entry = listMemory(projectId).find((e) => e.source === 'user')!
    const text = renderForPrompt([entry])
    expect(text).toContain('from the user')
    expect(text).toContain(entry.title)
  })

  it('parses provenance out of a hand-edited comment', () => {
    const f = parseMemoryFile(
      'project/gotchas.md',
      '# Gotchas\n\n## A thing\n<!-- vp source=user author=the_user at=2026-01-02 files=a.ts,b.ts ticket=t1 -->\n\nBody here.\n',
    )
    expect(f.entries).toHaveLength(1)
    const e = f.entries[0]!
    expect(e.source).toBe('user')
    expect(e.concerns).toEqual(['a.ts', 'b.ts'])
    expect(e.ticket).toBe('t1')
    expect(e.body).toBe('Body here.')
  })
})
