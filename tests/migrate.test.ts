import { createRequire } from 'node:module'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadMigrations, runMigrations } from '../src/main/db/migrate'

const nodeRequire = createRequire(process.execPath)
const { DatabaseSync } = nodeRequire('node:sqlite') as typeof import('node:sqlite')

/**
 * The upgrade path, with real rows in the way.
 *
 * Every other test opens a fresh database, which proves the migrations *parse* but not that
 * they preserve anything. `005_routes.sql` rebuilds the whole `tickets` table to widen a
 * CHECK constraint — the single most destructive thing in the schema history. This runs the
 * v1 migrations, fills them with data, then upgrades and checks the board survived.
 */
describe('migrating a database that already has work in it', () => {
  const open = () => new DatabaseSync(join(mkdtempSync(join(tmpdir(), 'vp-mig-')), 'test.db'), {
    enableForeignKeyConstraints: true,
  })

  /** Apply only migrations up to `version`, the way v1 left the database. */
  function applyUpTo(db: InstanceType<typeof DatabaseSync>, version: number): void {
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)`)
    for (const m of loadMigrations()) {
      if (m.version > version) break
      db.exec(m.sql)
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?,?,?)').run(
        m.version,
        m.name,
        Date.now(),
      )
    }
  }

  it('keeps every ticket, and maps the old stage vocabulary onto the new one', () => {
    const db = open()
    applyUpTo(db, 4)

    db.prepare(
      `INSERT INTO projects (id, name, path, default_base_branch, max_concurrent_agents,
        ticket_seq, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`,
    ).run('p1', 'Old', '/tmp/old', 'main', 3, 3, 1, 1)

    const insert = db.prepare(
      `INSERT INTO tickets (id, project_id, number, title, body, lane, stage, needs_planning,
        depends_on_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    )
    insert.run('t1', 'p1', 1, 'Old planning ticket', 'body', 'in_progress', 'plan', 1, '[]', 1, 1)
    insert.run('t2', 'p1', 2, 'Old verify ticket', '', 'in_progress', 'verify', 0, '[]', 1, 1)
    insert.run('t3', 'p1', 3, 'Old done ticket', '', 'done', null, 0, '[]', 1, 1)

    // Now upgrade the rest of the way — this is what happens on the user's next launch.
    const applied = runMigrations(db)
    expect(applied).toBeGreaterThan(0)

    const rows = db
      .prepare('SELECT id, title, lane, stage FROM tickets ORDER BY number')
      .all() as Array<{ id: string; title: string; lane: string; stage: string | null }>
    expect(rows, 'no ticket may be lost to a table rebuild').toHaveLength(3)
    expect(rows[0]!.title).toBe('Old planning ticket')
    expect(rows[0]!.stage).toBe('plan')
    // 'verify' is not a step kind any more; it becomes 'review'.
    expect(rows[1]!.stage).toBe('review')
    expect(rows[2]!.lane).toBe('done')

    db.close()
  })

  it('backfills a route for every existing ticket, so nothing loses its place', () => {
    const db = open()
    applyUpTo(db, 4)
    db.prepare(
      `INSERT INTO projects (id, name, path, default_base_branch, max_concurrent_agents,
        ticket_seq, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`,
    ).run('p1', 'Old', '/tmp/old2', 'main', 3, 2, 1, 1)
    const insert = db.prepare(
      `INSERT INTO tickets (id, project_id, number, title, body, lane, stage, needs_planning,
        depends_on_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    )
    insert.run('t1', 'p1', 1, 'Needed planning', '', 'in_progress', 'plan', 1, '[]', 1, 1)
    insert.run('t2', 'p1', 2, 'Did not', '', 'in_progress', 'build', 0, '[]', 1, 1)

    runMigrations(db)

    const routes = db
      .prepare("SELECT ticket_id, status, steps_json FROM ticket_routes WHERE status = 'accepted' ORDER BY ticket_id")
      .all() as Array<{ ticket_id: string; status: string; steps_json: string }>
    expect(routes).toHaveLength(2)

    // A ticket flagged "needs planning" becomes [plan, build]; everything else [build].
    const kinds = (json: string): string[] =>
      (JSON.parse(json) as Array<{ kind: string }>).map((s) => s.kind)
    expect(kinds(routes[0]!.steps_json)).toEqual(['plan', 'build'])
    expect(kinds(routes[1]!.steps_json)).toEqual(['build'])

    db.close()
  })

  /*
   * Auto-archive arrives switched on, so the first heartbeat after the upgrade could sweep a
   * board carrying months of finished work in one silent pass — the honest "when did this
   * finish" timestamp is not recoverable, which is why the column is being added at all.
   * Starting everyone's clock at the upgrade is what turns that into three days of grace.
   */
  it('starts the auto-archive clock at the upgrade, not before it', () => {
    const db = open()
    applyUpTo(db, 23)

    db.prepare(
      `INSERT INTO projects (id, name, path, default_base_branch, max_concurrent_agents,
        ticket_seq, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`,
    ).run('p1', 'Busy', '/tmp/busy', 'main', 3, 2, 1, 1)

    const insert = db.prepare(
      `INSERT INTO tickets (id, project_id, number, title, body, lane, needs_planning,
        depends_on_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    )
    // Finished long ago by `updated_at`, which is exactly the number that must not be used.
    insert.run('t1', 'p1', 1, 'Shipped in March', '', 'done', 0, '[]', 1, 1)
    insert.run('t2', 'p1', 2, 'Still going', '', 'todo', 0, '[]', 1, 1)

    runMigrations(db)

    const rows = db
      .prepare('SELECT id, done_at FROM tickets ORDER BY number')
      .all() as Array<{ id: string; done_at: number | null }>
    expect(rows[0]!.done_at).toBeGreaterThan(Date.now() - 60_000)
    expect(rows[1]!.done_at).toBeNull()

    const project = db.prepare('SELECT auto_archive_days FROM projects').get() as {
      auto_archive_days: number
    }
    expect(project.auto_archive_days).toBe(3)

    db.close()
  })

  it('is idempotent — running again applies nothing', () => {
    const db = open()
    runMigrations(db)
    expect(runMigrations(db)).toBe(0)
    db.close()
  })

  it('every migration has a distinct, ordered version', () => {
    const versions = loadMigrations().map((m) => m.version)
    expect(new Set(versions).size).toBe(versions.length)
    expect([...versions].sort((a, b) => a - b)).toEqual(versions)
  })
})
