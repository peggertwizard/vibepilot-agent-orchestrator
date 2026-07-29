import type { DatabaseSync } from 'node:sqlite'

/**
 * Migrations are bundled as raw strings rather than read from disk, so the same code path
 * works in dev and inside an asar archive.
 */
const files = import.meta.glob('./migrations/*.sql', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

export interface Migration {
  version: number
  name: string
  sql: string
}

export function loadMigrations(): Migration[] {
  return Object.entries(files)
    .map(([path, sql]) => {
      const name = path.split('/').pop() ?? path
      const version = Number(name.slice(0, 3))
      if (!Number.isInteger(version)) {
        throw new Error(`Migration "${name}" must start with a 3-digit version, e.g. 001_init.sql`)
      }
      return { version, name, sql }
    })
    .sort((a, b) => a.version - b.version)
}

export function runMigrations(db: DatabaseSync): number {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at INTEGER NOT NULL
  )`)

  const applied = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map(
      (r) => r.version,
    ),
  )

  const insert = db.prepare(
    'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
  )

  let count = 0
  for (const m of loadMigrations()) {
    if (applied.has(m.version)) continue
    db.exec('BEGIN')
    try {
      db.exec(m.sql)
      insert.run(m.version, m.name, Date.now())
      db.exec('COMMIT')
      count++
    } catch (e) {
      db.exec('ROLLBACK')
      throw new Error(`Migration ${m.name} failed: ${(e as Error).message}`)
    }
  }
  return count
}
