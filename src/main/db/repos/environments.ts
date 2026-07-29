import type { Deployment, Environment } from '@shared/types'
import { all, bool, fromBool, get, id, now, run } from '../index'

/**
 * Where finished work can be sent.
 *
 * `deploy_cmd` and `deploy_note` existed on the project row since migration 016 and were
 * **executed by nothing** — pasted into an agent's system prompt as prose and left there. That
 * was the whole deployment lifecycle. A project also had exactly one of them, so there was no
 * way to express dev-then-production, which is the shape every real deployment has.
 *
 * The old single command becomes the first row rather than a special case.
 */

type Row = Record<string, unknown>

function map(r: Row): Environment {
  return {
    id: r['id'] as string,
    projectId: r['project_id'] as string,
    name: r['name'] as string,
    cmd: r['cmd'] as string,
    confirm: fromBool(r['confirm']),
    position: r['position'] as number,
    createdAt: r['created_at'] as number,
  }
}

export function listEnvironments(projectId: string): Environment[] {
  return all<Row>(
    'SELECT * FROM environments WHERE project_id = ? ORDER BY position, created_at',
    projectId,
  ).map(map)
}

export function getEnvironment(envId: string): Environment | null {
  const r = get<Row>('SELECT * FROM environments WHERE id = ?', envId)
  return r ? map(r) : null
}

/** By name, because that is what the Pilot has: `deploy("production")`. */
export function findEnvironment(projectId: string, name: string): Environment | null {
  const r = get<Row>(
    'SELECT * FROM environments WHERE project_id = ? AND lower(name) = lower(?)',
    projectId,
    name.trim(),
  )
  return r ? map(r) : null
}

export function upsertEnvironment(input: {
  projectId: string
  name: string
  cmd: string
  confirm?: boolean
  position?: number
}): Environment {
  const existing = findEnvironment(input.projectId, input.name)
  if (existing) {
    run(
      'UPDATE environments SET cmd = ?, confirm = ?, position = ? WHERE id = ?',
      input.cmd,
      bool(input.confirm ?? existing.confirm),
      input.position ?? existing.position,
      existing.id,
    )
    return getEnvironment(existing.id)!
  }
  const eid = id()
  run(
    'INSERT INTO environments (id, project_id, name, cmd, confirm, position, created_at) VALUES (?,?,?,?,?,?,?)',
    eid,
    input.projectId,
    input.name.trim(),
    input.cmd,
    /*
     * Default on. An environment nobody has thought about is more likely to be the one that
     * reaches other people than the one that does not.
     */
    bool(input.confirm ?? true),
    input.position ?? listEnvironments(input.projectId).length,
    now(),
  )
  return getEnvironment(eid)!
}

export function deleteEnvironment(envId: string): void {
  run('DELETE FROM environments WHERE id = ?', envId)
}

/* ── history ────────────────────────────────────────────────────────────────── */

function mapDeployment(r: Row): Deployment {
  return {
    id: r['id'] as string,
    projectId: r['project_id'] as string,
    environmentId: (r['environment_id'] as string | null) ?? null,
    environment: r['environment'] as string,
    ticketId: (r['ticket_id'] as string | null) ?? null,
    byAgentId: (r['by_agent_id'] as string | null) ?? null,
    ok: fromBool(r['ok']),
    exitCode: (r['exit_code'] as number | null) ?? null,
    output: (r['output'] as string) ?? '',
    startedAt: r['started_at'] as number,
    finishedAt: r['finished_at'] as number,
  }
}

/** Without this, "is the fix live?" has no answer inside the app. */
export function listDeployments(projectId: string, limit = 30): Deployment[] {
  return all<Row>(
    'SELECT * FROM deployments WHERE project_id = ? ORDER BY started_at DESC LIMIT ?',
    projectId,
    limit,
  ).map(mapDeployment)
}

export function recordDeployment(input: {
  projectId: string
  environmentId: string | null
  environment: string
  ticketId: string | null
  byAgentId: string | null
  ok: boolean
  exitCode: number | null
  output: string
  startedAt: number
}): Deployment {
  const did = id()
  run(
    `INSERT INTO deployments
       (id, project_id, environment_id, environment, ticket_id, by_agent_id, ok, exit_code,
        output, started_at, finished_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    did,
    input.projectId,
    input.environmentId,
    input.environment,
    input.ticketId,
    input.byAgentId,
    bool(input.ok),
    input.exitCode,
    input.output,
    input.startedAt,
    now(),
  )
  return mapDeployment(get<Row>('SELECT * FROM deployments WHERE id = ?', did)!)
}
