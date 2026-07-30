import { createRequire } from 'node:module'
import type { DatabaseSync as DatabaseSyncType, StatementSync } from 'node:sqlite'
import { randomUUID, randomBytes } from 'node:crypto'
import { dbPath } from '../paths'
import { runMigrations } from './migrate'

/**
 * Thin wrapper over `node:sqlite`.
 *
 * We use the stdlib driver rather than better-sqlite3 because better-sqlite3 needs Visual
 * Studio build tools plus an Electron ABI rebuild, and this app is meant to be something
 * you just run. Electron 43 ships Node 24, whose `node:sqlite` has FTS5 and JSON1.
 *
 * The API is close to better-sqlite3 but missing three things, absorbed here:
 *   - no `db.transaction(fn)`  -> `tx()`
 *   - no `.pluck()`            -> `pluck()`
 *   - booleans are not bindable -> `bool()` / callers store 0|1
 */

export type Row = Record<string, unknown>
export type Bind = string | number | null | Uint8Array

/**
 * Loaded through createRequire rather than a static import.
 *
 * `node:sqlite` is `isBuiltin()` true but absent from `module.builtinModules` because it is
 * still marked experimental — so bundlers that externalize builtins by consulting that list
 * (Vite, Rollup) try to bundle it and fail to resolve. A runtime require is invisible to
 * static analysis and reaches Node untouched in dev, test and a packaged app alike.
 */
const nodeRequire = createRequire(process.execPath)
const { DatabaseSync } = nodeRequire('node:sqlite') as typeof import('node:sqlite')

let db: DatabaseSyncType | null = null

export function openDb(file = dbPath()): DatabaseSyncType {
  if (db) return db
  const d = new DatabaseSync(file, { enableForeignKeyConstraints: true })
  // WAL keeps readers off the writer's back; NORMAL is the right durability trade for a
  // local app whose worst-case loss is a few hundred ms of event log.
  d.exec('PRAGMA journal_mode = WAL')
  d.exec('PRAGMA synchronous = NORMAL')
  d.exec('PRAGMA busy_timeout = 5000')
  db = d
  runMigrations(d)
  return d
}

export function getDb(): DatabaseSyncType {
  if (!db) throw new Error('Database not open. Call openDb() during app startup.')
  return db
}

export function closeDb(): void {
  db?.close()
  db = null
}

const stmtCache = new Map<string, StatementSync>()

/** Prepared-statement cache. node:sqlite has no built-in one and preparing is not free. */
export function prep(sql: string): StatementSync {
  let s = stmtCache.get(sql)
  if (!s) {
    s = getDb().prepare(sql)
    stmtCache.set(sql, s)
  }
  return s
}

export function run(sql: string, ...args: Bind[]): { changes: number; lastInsertRowid: number } {
  const r = prep(sql).run(...args)
  return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) }
}

export function get<T = Row>(sql: string, ...args: Bind[]): T | undefined {
  return prep(sql).get(...args) as T | undefined
}

export function all<T = Row>(sql: string, ...args: Bind[]): T[] {
  return prep(sql).all(...args) as T[]
}

/** better-sqlite3's `.pluck()` — return the first column of each row. */
export function pluck<T = unknown>(sql: string, ...args: Bind[]): T[] {
  return all<Row>(sql, ...args).map((r) => Object.values(r)[0] as T)
}

let txDepth = 0

/**
 * Transaction helper. Nests via SAVEPOINT so a repo function can call another
 * repo function without either needing to know who owns the transaction.
 */
export function tx<T>(fn: () => T): T {
  const d = getDb()
  const depth = txDepth++
  const sp = depth === 0 ? null : `sp_${depth}`
  d.exec(sp ? `SAVEPOINT ${sp}` : 'BEGIN')
  try {
    const out = fn()
    d.exec(sp ? `RELEASE ${sp}` : 'COMMIT')
    return out
  } catch (e) {
    try {
      d.exec(sp ? `ROLLBACK TO ${sp}` : 'ROLLBACK')
      if (sp) d.exec(`RELEASE ${sp}`)
    } catch {
      /* the outer failure is the interesting one */
    }
    throw e
  } finally {
    txDepth--
  }
}

// ── binding helpers ────────────────────────────────────────────────────────────
/** node:sqlite refuses booleans. Store 0/1. */
export const bool = (v: boolean | undefined | null): number => (v ? 1 : 0)
export const fromBool = (v: unknown): boolean => v === 1 || v === true
export const json = (v: unknown): string => JSON.stringify(v ?? null)
export function parseJson<T>(v: unknown, fallback: T): T {
  if (typeof v !== 'string' || !v) return fallback
  try {
    return JSON.parse(v) as T
  } catch {
    return fallback
  }
}

export const now = (): number => Date.now()
export const uuid = (): string => randomUUID()
/** Short, URL-safe, collision-resistant enough for local rows and nicer in logs than a UUID. */
export const id = (): string => randomBytes(9).toString('base64url')
