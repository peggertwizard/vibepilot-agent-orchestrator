import { readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { EffortLevel, EscalationLevel, Project, ProjectChecks } from '@shared/types'
import { DEFAULT_ESCALATION } from '@shared/types'
import { all, get, id, now, run, tx } from '../index'

type Row = Record<string, unknown>

function map(r: Row): Project {
  return {
    id: r['id'] as string,
    name: r['name'] as string,
    path: r['path'] as string,
    gitRemote: (r['git_remote'] as string | null) ?? null,
    defaultBaseBranch: r['default_base_branch'] as string,
    maxConcurrentAgents: r['max_concurrent_agents'] as number,
    escalation: (r['escalation'] as EscalationLevel | null) ?? DEFAULT_ESCALATION,
    // Absent means not trusted. Never default this to true — see migration 017.
    settingsTrusted: (r['settings_trusted'] as number | null) === 1,
    checks: {
      test: (r['cmd_test'] as string | null) ?? null,
      typecheck: (r['cmd_typecheck'] as string | null) ?? null,
      lint: (r['cmd_lint'] as string | null) ?? null,
      build: (r['cmd_build'] as string | null) ?? null,
    },
    deployCmd: (r['deploy_cmd'] as string | null) ?? null,
    deployNote: (r['deploy_note'] as string | null) ?? null,
    reviewPasses: (r['review_passes'] as number | null) ?? null,
    reviewSensitivity: (r['review_sensitivity'] as number | null) ?? 5,
    launchPaused: (r['launch_paused'] as number | null) === 1,
    pilotModel: (r['pilot_model'] as string | null) ?? null,
    pilotEffort: (r['pilot_effort'] as EffortLevel | null) ?? null,
    spendCeilingUsd: (r['spend_ceiling_usd'] as number | null) ?? null,
    autoStart: (r['auto_start'] as Project['autoStart']) ?? 'simple',
    autoMerge: (r['auto_merge'] as Project['autoMerge']) ?? 'green',
    autoArchiveDays: (r['auto_archive_days'] as number | null) ?? 3,
    previewCmd: (r['preview_cmd'] as string | null) ?? null,
    rateLimitStatus: (r['rate_limit_status'] as string | null) ?? null,
    rateLimitResetsAt: (r['rate_limit_resets_at'] as number | null) ?? null,
    ticketSeq: r['ticket_seq'] as number,
    bootstrappedAt: (r['bootstrapped_at'] as number | null) ?? null,
    archivedAt: (r['archived_at'] as number | null) ?? null,
    createdAt: r['created_at'] as number,
    updatedAt: r['updated_at'] as number,
  }
}

/**
 * Guess how this project is checked, from what is actually in it.
 *
 * A `package.json` with a `test` script is not a guess — it is a fact about the repo, and
 * pre-filling from it is the difference between a settings screen people fill in and one they
 * look at once. Wrong guesses are cheap: every field is editable and an empty one just means
 * that check does not run.
 */
export function detectChecks(projectPath: string): ProjectChecks {
  const empty: ProjectChecks = { test: null, typecheck: null, lint: null, build: null }
  try {
    const pkg = JSON.parse(readFileSync(join(projectPath, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>
    }
    const scripts = pkg.scripts ?? {}
    const has = (name: string): string | null => (scripts[name] ? `npm run ${name}` : null)
    return {
      // `npm test` is the one script with a bare alias, and it is the one people type.
      test: scripts['test'] ? 'npm test' : null,
      typecheck: has('typecheck') ?? has('type-check') ?? has('tsc'),
      lint: has('lint'),
      build: has('build'),
    }
  } catch {
    // No package.json, or unreadable. Other ecosystems get an empty form rather than a wrong
    // guess — Cargo and Go are worth adding once someone points vibePilot at one.
    return empty
  }
}

export function listProjects(): Project[] {
  return all<Row>('SELECT * FROM projects WHERE archived_at IS NULL ORDER BY created_at').map(map)
}

export function getProject(projectId: string): Project | null {
  const r = get<Row>('SELECT * FROM projects WHERE id = ?', projectId)
  return r ? map(r) : null
}

export function getProjectByPath(path: string): Project | null {
  const r = get<Row>('SELECT * FROM projects WHERE path = ?', path)
  return r ? map(r) : null
}

export function addProject(input: {
  path: string
  name?: string
  gitRemote?: string | null
  defaultBaseBranch?: string
}): Project {
  const existing = getProjectByPath(input.path)
  if (existing) return existing

  const t = now()
  const pid = id()
  const detected = detectChecks(input.path)
  run(
    /*
     * `auto_start` is written explicitly rather than left to the column default.
     *
     * Migration 019 created that column with DEFAULT 'never', and SQLite cannot alter a
     * default without rebuilding the table. Migration 023 moved existing projects to 'simple';
     * without this line, every *new* project would still be created with the old caution and
     * the two would silently disagree about what the default is.
     */
    `INSERT INTO projects
       (id, name, path, git_remote, default_base_branch, max_concurrent_agents,
        ticket_seq, cmd_test, cmd_typecheck, cmd_lint, cmd_build, auto_start,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 3, 0, ?, ?, ?, ?, 'simple', ?, ?)`,
    pid,
    input.name ?? basename(input.path),
    input.path,
    input.gitRemote ?? null,
    input.defaultBaseBranch ?? 'main',
    detected.test,
    detected.typecheck,
    detected.lint,
    detected.build,
    t,
    t,
  )
  return getProject(pid)!
}

export function updateProject(
  projectId: string,
  patch: Partial<
    Pick<
      Project,
      | 'name'
      | 'defaultBaseBranch'
      | 'maxConcurrentAgents'
      | 'gitRemote'
      | 'escalation'
      | 'settingsTrusted'
      | 'deployCmd'
      | 'deployNote'
      | 'reviewPasses'
      | 'reviewSensitivity'
      | 'launchPaused'
      | 'pilotModel'
      | 'pilotEffort'
      | 'spendCeilingUsd'
      | 'autoStart'
      | 'autoMerge'
      | 'autoArchiveDays'
      | 'previewCmd'
    >
  > & { checks?: Partial<ProjectChecks> },
): Project | null {
  const sets: string[] = []
  const args: (string | number | null)[] = []
  if (patch.name !== undefined) (sets.push('name = ?'), args.push(patch.name))
  if (patch.defaultBaseBranch !== undefined)
    (sets.push('default_base_branch = ?'), args.push(patch.defaultBaseBranch))
  if (patch.maxConcurrentAgents !== undefined)
    (sets.push('max_concurrent_agents = ?'), args.push(patch.maxConcurrentAgents))
  if (patch.gitRemote !== undefined) (sets.push('git_remote = ?'), args.push(patch.gitRemote))
  if (patch.escalation !== undefined) (sets.push('escalation = ?'), args.push(patch.escalation))
  /*
   * These two were in the patch type and the IPC schema, and had no SET clause — so the
   * reviewer slider and the pause button both round-tripped through IPC, wrote nothing, and
   * sprang back to the stored default. A whole control can be inert while every layer around
   * it type-checks; the only proof is a writer.
   */
  if (patch.reviewSensitivity !== undefined)
    (sets.push('review_sensitivity = ?'), args.push(patch.reviewSensitivity))
  if (patch.launchPaused !== undefined)
    (sets.push('launch_paused = ?'), args.push(patch.launchPaused ? 1 : 0))
  if (patch.settingsTrusted !== undefined)
    (sets.push('settings_trusted = ?'), args.push(patch.settingsTrusted ? 1 : 0))
  if (patch.deployCmd !== undefined) (sets.push('deploy_cmd = ?'), args.push(patch.deployCmd))
  if (patch.deployNote !== undefined) (sets.push('deploy_note = ?'), args.push(patch.deployNote))
  if (patch.reviewPasses !== undefined)
    (sets.push('review_passes = ?'), args.push(patch.reviewPasses))
  if (patch.pilotModel !== undefined) (sets.push('pilot_model = ?'), args.push(patch.pilotModel))
  if (patch.pilotEffort !== undefined) (sets.push('pilot_effort = ?'), args.push(patch.pilotEffort))
  if (patch.spendCeilingUsd !== undefined)
    (sets.push('spend_ceiling_usd = ?'), args.push(patch.spendCeilingUsd))
  if (patch.autoStart !== undefined) (sets.push('auto_start = ?'), args.push(patch.autoStart))
  if (patch.autoMerge !== undefined) (sets.push('auto_merge = ?'), args.push(patch.autoMerge))
  if (patch.autoArchiveDays !== undefined)
    (sets.push('auto_archive_days = ?'), args.push(patch.autoArchiveDays))
  if (patch.previewCmd !== undefined) (sets.push('preview_cmd = ?'), args.push(patch.previewCmd))

  // An empty string means "this project has no such command" — store NULL so every reader can
  // test one thing rather than two.
  const cmdColumn: Record<keyof ProjectChecks, string> = {
    test: 'cmd_test',
    typecheck: 'cmd_typecheck',
    lint: 'cmd_lint',
    build: 'cmd_build',
  }
  for (const [key, column] of Object.entries(cmdColumn) as Array<[keyof ProjectChecks, string]>) {
    const v = patch.checks?.[key]
    if (v === undefined) continue
    sets.push(`${column} = ?`)
    args.push(v && v.trim() ? v.trim() : null)
  }
  if (sets.length === 0) return getProject(projectId)

  sets.push('updated_at = ?')
  args.push(now(), projectId)
  run(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`, ...args)
  return getProject(projectId)
}

/** Rate-limit state, from the CLI's own rate_limit_event. */
export function setProjectQuota(
  projectId: string,
  status: string,
  resetsAt: number | null,
): void {
  run(
    'UPDATE projects SET rate_limit_status = ?, rate_limit_resets_at = ?, updated_at = ? WHERE id = ?',
    status,
    resetsAt,
    now(),
    projectId,
  )
}

export function archiveProject(projectId: string): void {
  run('UPDATE projects SET archived_at = ?, updated_at = ? WHERE id = ?', now(), now(), projectId)
}

/**
 * Allocate the next ticket number for a project.
 *
 * Must be called inside the same transaction as the ticket insert. `MAX(number) + 1`
 * collides when the Pilot and a teammate create a ticket in the same tick.
 */
export function nextTicketNumber(projectId: string): number {
  return tx(() => {
    const r = get<{ ticket_seq: number }>(
      'UPDATE projects SET ticket_seq = ticket_seq + 1 WHERE id = ? RETURNING ticket_seq',
      projectId,
    )
    if (!r) throw new Error(`No such project: ${projectId}`)
    return r.ticket_seq
  })
}

/**
 * What this project has spent, in notional list-price dollars.
 *
 * `spend_ceiling_usd` has been stored and validated since migration 016 and read by nothing.
 * That was survivable while every launch needed a human press — the user saw the number on the
 * card and decided. Once work starts by itself there is no button to not-press, so the ceiling
 * has to be the actual control rather than a backstop nobody consults.
 *
 * MAX per run then sum the runs, the same shape `ticketSpend` uses: `cost_usd` on a usage event
 * is cumulative for that run, so summing the rows would count every turn again.
 */
export function projectSpend(projectId: string): number {
  const row = get<Record<string, unknown>>(
    `SELECT COALESCE(SUM(m), 0) AS total FROM (
       SELECT MAX(cost_usd) AS m FROM usage_events
       WHERE project_id = ? AND run_id IS NOT NULL GROUP BY run_id
     )`,
    projectId,
  )
  return (row?.['total'] as number | undefined) ?? 0
}

/**
 * Is there room under the ceiling to start something new?
 *
 * Returns a sentence when there is not, so every caller reports the same reason in the same
 * words rather than inventing its own.
 */
export function spendBlocked(projectId: string): string | null {
  const project = getProject(projectId)
  if (!project?.spendCeilingUsd) return null
  const spent = projectSpend(projectId)
  if (spent < project.spendCeilingUsd) return null
  return (
    `This project has spent $${spent.toFixed(2)} against a ceiling of ` +
    `$${project.spendCeilingUsd.toFixed(2)}. Raise the ceiling in Settings, or reset the ` +
    `counters, before anything else starts.`
  )
}
