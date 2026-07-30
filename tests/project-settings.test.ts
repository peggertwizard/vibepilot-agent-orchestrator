import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeDb, openDb } from '../src/main/db'
import { addProject, detectChecks, getProject, updateProject } from '../src/main/db/repos/projects'
import { renderChecks, runChecks, runCommand } from '../src/main/engine/checks'
import { MAX_REVIEW_PASSES, configuredChecks } from '../src/shared/types'

/**
 * Verification used to be prose. A rule file told the agent *"the project's tests pass,
 * typecheck and lint are clean"* and nothing anywhere checked whether that had happened — so an
 * agent that verified and one that said it did were indistinguishable on the evidence.
 *
 * Naming the commands makes the claim checkable, and vibePilot running them is what makes the
 * exit code a fact rather than a report.
 */
describe('project settings', () => {
  let projectId: string
  let repo: string

  beforeAll(() => {
    openDb(join(mkdtempSync(join(tmpdir(), 'vp-set-')), 'test.db'))
    repo = mkdtempSync(join(tmpdir(), 'vp-setproj-'))
    writeFileSync(
      join(repo, 'package.json'),
      JSON.stringify({ scripts: { test: 'vitest run', typecheck: 'tsc', build: 'vite build' } }),
    )
    projectId = addProject({ path: repo, name: 'Settings' }).id
  })

  afterAll(() => closeDb())

  /* ── detection ───────────────────────────────────────────────────────────── */

  it('fills the commands in from package.json when the project is added', () => {
    const p = getProject(projectId)!

    // `npm test` is the one script with a bare alias, and it is what people type.
    expect(p.checks.test).toBe('npm test')
    expect(p.checks.typecheck).toBe('npm run typecheck')
    expect(p.checks.build).toBe('npm run build')
    // Not in the file, so not guessed at.
    expect(p.checks.lint).toBeNull()
  })

  it('gives an empty form rather than a wrong guess when there is no package.json', () => {
    expect(detectChecks(mkdtempSync(join(tmpdir(), 'vp-bare-')))).toEqual({
      test: null,
      typecheck: null,
      lint: null,
      build: null,
    })
  })

  it('lists only what is configured, in the order you would run them', () => {
    expect(configuredChecks(getProject(projectId)!.checks).map((c) => c.kind)).toEqual([
      'typecheck',
      'test',
      'build',
    ])
  })

  /* ── storage ─────────────────────────────────────────────────────────────── */

  it('stores a blank command as nothing, not as an empty command to run', () => {
    updateProject(projectId, { checks: { build: '   ' } })
    expect(getProject(projectId)!.checks.build).toBeNull()
    expect(configuredChecks(getProject(projectId)!.checks).map((c) => c.kind)).toEqual([
      'typecheck',
      'test',
    ])
  })

  it('keeps the settings that used to be constants or global', () => {
    expect(getProject(projectId)!.reviewPasses, 'null follows the default').toBeNull()

    updateProject(projectId, {
      reviewPasses: 1,
      // Was one global localStorage key, so a throwaway repo and a business project shared
      // one expensive model.
      pilotModel: 'haiku',
      pilotEffort: 'low',
      spendCeilingUsd: 25,
      deployCmd: 'npm run deploy',
      deployNote: 'Builds, uploads, then runs pending migrations.',
    })

    const p = getProject(projectId)!
    expect(p.reviewPasses).toBe(1)
    expect(p.reviewPasses).not.toBe(MAX_REVIEW_PASSES)
    expect(p.pilotModel).toBe('haiku')
    expect(p.pilotEffort).toBe('low')
    expect(p.spendCeilingUsd).toBe(25)
    expect(p.deployCmd).toBe('npm run deploy')
  })

  it('reads back the rate-limit state it has always written and never read', () => {
    // The row mapper did not even select these, so a board that stalled overnight came back
    // with no explanation for why nothing was moving.
    const p = getProject(projectId)!
    expect(p).toHaveProperty('rateLimitStatus')
    expect(p).toHaveProperty('rateLimitResetsAt')
  })

  /* ── running them ────────────────────────────────────────────────────────── */

  it('reports a real exit code, not a claim about one', async () => {
    const ok = await runCommand('node -e "process.exit(0)"', repo)
    expect(ok.ok).toBe(true)
    expect(ok.exitCode).toBe(0)

    const bad = await runCommand('node -e "console.error(\'boom\'); process.exit(3)"', repo)
    expect(bad.ok).toBe(false)
    expect(bad.exitCode).toBe(3)
    expect(bad.output).toMatch(/boom/)
  })

  it('runs every configured check and does not stop at the first failure', async () => {
    const results = await runChecks(
      {
        typecheck: 'node -e "process.exit(1)"',
        lint: null,
        test: 'node -e "process.exit(0)"',
        build: 'node -e "process.exit(1)"',
      },
      repo,
    )

    // Knowing that typecheck AND build are broken is worth more, in one turn, than finding out
    // one at a time.
    expect(results.map((r) => r.kind)).toEqual(['typecheck', 'test', 'build'])
    expect(results.filter((r) => !r.ok).map((r) => r.kind)).toEqual(['typecheck', 'build'])
  })

  it('tells the agent plainly what passed and what did not', async () => {
    const results = await runChecks(
      { typecheck: null, lint: null, test: 'node -e "process.exit(2)"', build: null },
      repo,
    )
    const text = renderChecks(results)

    expect(text).toMatch(/failed/i)
    expect(text).toMatch(/exit 2/)
    expect(text).toMatch(/do not report the ticket as done/i)
  })

  it('says so when a project has configured nothing, rather than implying it passed', () => {
    expect(renderChecks([])).toMatch(/no checks configured/i)
  })
})
