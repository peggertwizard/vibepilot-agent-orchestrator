import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeDb, openDb } from '../src/main/db'
import { flushWrites } from '../src/main/db/writer'
import { addProject } from '../src/main/db/repos/projects'
import { createAgent } from '../src/main/db/repos/agents'
import {
  findEnvironment,
  listDeployments,
  listEnvironments,
  upsertEnvironment,
} from '../src/main/db/repos/environments'
import { callTool } from '../src/main/mcp/tools'
import { hasDependencies, startPreview } from '../src/main/engine/preview'

/**
 * Where finished work goes, and what refuses to send it there.
 *
 * `deploy_cmd` was stored on the project row since migration 016 and executed by nothing — it
 * was pasted into an agent's system prompt as prose and left there. So the assertions here are
 * mostly about the gate rather than the mechanism: the mechanism is `runCommand`, which
 * already streams output and already has a timeout, and deploying is `run_checks` with a
 * different list and a stop.
 */

let projectId: string
let pilotId: string

const pilot = () =>
  ({ runId: 'r0', agentId: pilotId, projectId, ticketId: null, role: 'pilot' }) as const

beforeAll(() => {
  openDb(join(mkdtempSync(join(tmpdir(), 'vp-db-')), 'test.db'))
  const repo = mkdtempSync(join(tmpdir(), 'vp-repo-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })

  projectId = addProject({ path: repo, name: 'Ship' }).id
  pilotId = createAgent({
    projectId,
    name: 'Pilot',
    role: 'pilot',
    provider: 'claude',
    model: 'sonnet',
    isPilot: true,
  }).id
})

afterAll(() => {
  flushWrites()
  closeDb()
})

describe('the environments are the user’s', () => {
  it('refuses when there are none, rather than improvising a command', async () => {
    const res = await callTool('deploy', { environment: 'production' }, pilot())
    expect(res.structuredContent?.['ok']).toBe(false)
    expect(String(res.content[0]?.text)).toContain('no environments configured')
  })

  it('names what does exist when asked for one that does not', async () => {
    upsertEnvironment({ projectId, name: 'dev', cmd: 'echo shipped', confirm: false })
    const res = await callTool('deploy', { environment: 'staging' }, pilot())
    expect(res.structuredContent?.['ok']).toBe(false)
    expect(String(res.content[0]?.text)).toContain('dev')
  })

  it('defaults a new environment to asking first', () => {
    const e = upsertEnvironment({ projectId, name: 'preprod', cmd: 'echo x' })
    // An environment nobody has thought about is more likely to be the one that reaches
    // other people than the one that does not.
    expect(e.confirm).toBe(true)
  })
})

describe('the gate', () => {
  it('refuses an environment marked as needing confirmation, and says it cannot be worked around', async () => {
    upsertEnvironment({ projectId, name: 'production', cmd: 'echo live', confirm: true })
    const res = await callTool('deploy', { environment: 'production' }, pilot())
    expect(res.structuredContent?.['ok']).toBe(false)
    expect(String(res.content[0]?.text)).toContain('needs the user to confirm')
    expect(String(res.content[0]?.text)).toContain('not a setting you can work around')
    // Nothing ran. That is the assertion, not the wording.
    expect(listDeployments(projectId).some((d) => d.environment === 'production')).toBe(false)
  })

  it('runs one that does not, and records it', async () => {
    const res = await callTool('deploy', { environment: 'dev' }, pilot())
    expect(res.structuredContent?.['ok']).toBe(true)

    const [latest] = listDeployments(projectId)
    expect(latest?.environment).toBe('dev')
    expect(latest?.ok).toBe(true)
    // Without the record, "is the fix live?" has no answer inside the app.
    expect(latest?.finishedAt).toBeGreaterThanOrEqual(latest!.startedAt)
  })

  it('reports a failing deploy as a failure rather than swallowing it', async () => {
    upsertEnvironment({ projectId, name: 'broken', cmd: 'exit 3', confirm: false })
    const res = await callTool('deploy', { environment: 'broken' }, pilot())
    expect(res.structuredContent?.['ok']).toBe(false)
    expect(String(res.content[0]?.text)).toContain('Do not retry it')
    expect(listDeployments(projectId).find((d) => d.environment === 'broken')?.ok).toBe(false)
  })
})

describe('environments as a ladder', () => {
  it('keeps them in the order they were added, so the list reads as a sequence', () => {
    const names = listEnvironments(projectId).map((e) => e.name)
    expect(names[0]).toBe('dev')
  })

  it('updates rather than duplicating an existing name', () => {
    upsertEnvironment({ projectId, name: 'dev', cmd: 'echo changed', confirm: false })
    expect(listEnvironments(projectId).filter((e) => e.name === 'dev')).toHaveLength(1)
    expect(findEnvironment(projectId, 'DEV')?.cmd).toBe('echo changed')
  })
})

describe('preview', () => {
  it('refuses without a preview command, and says how to set one', () => {
    const res = startPreview('nope')
    expect(res.ok).toBe(false)
  })

  it('reports a worktree with no dependencies rather than letting it fail obscurely', () => {
    const empty = mkdtempSync(join(tmpdir(), 'vp-wt-'))
    // No package.json at all means nothing to install — not a problem.
    expect(hasDependencies(empty)).toBe(true)
  })
})

describe('remembering is part of finishing', () => {
  /**
   * A teammate on a real migration bug ended its run saying it had left "a lessons-learned
   * note". What it had written was a README describing the memory folder structure, plus an
   * empty directory. The finding — that dev-mode `push` had been sole writer to the dev
   * database for weeks — existed only in its final report and died with it.
   *
   * It was told memory mattered and never told that `remember` was the mechanism. Prompt
   * wording did not hold, so this is a refusal it has to handle.
   */
  it('refuses to finish until something is written down, and offers the way out', async () => {
    const { createTicket } = await import('../src/main/db/repos/tickets')
    const t = createTicket({ projectId, title: 'Fix it', body: '', lane: 'todo' })
    flushWrites()

    const builder = createAgent({
      projectId,
      name: 'Kit',
      role: 'builder',
      provider: 'claude',
      model: 'sonnet',
      isRoster: true,
    })
    const { updateTicket } = await import('../src/main/db/repos/tickets')
    updateTicket(t.id, { assigneeAgentId: builder.id })
    flushWrites()

    const binding = {
      runId: 'r1',
      agentId: builder.id,
      projectId,
      ticketId: t.id,
      role: 'builder',
    } as const

    const first = await callTool(
      'mark_ready_to_merge',
      { ticket: t.number, summary: 'done' },
      binding,
    )
    expect(first.structuredContent?.['ok']).toBe(false)
    expect(String(first.content[0]?.text)).toContain('did you learn anything')
    // The escape hatch is in the same breath as the refusal — asking twice would be nagging.
    expect(String(first.content[0]?.text)).toContain('nothing_to_remember')

    // Taken at its word, once said.
    const second = await callTool(
      'mark_ready_to_merge',
      { ticket: t.number, summary: 'done', nothing_to_remember: true },
      binding,
    )
    expect(String(second.content[0]?.text)).not.toContain('did you learn anything')
  })
})
