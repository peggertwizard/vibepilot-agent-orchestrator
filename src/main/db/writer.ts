import { getDb, prep, type Bind } from './index'

/**
 * Batched writer.
 *
 * `node:sqlite` is synchronous, so a `.run()` on the main thread blocks the Electron event
 * loop — which blocks the NDJSON readers of *every other agent*. Four agents at ~200
 * events/s will visibly stutter the UI. Everything on the hot path (events, tool summaries,
 * usage) goes through here; interactive writes the user is waiting on do not.
 */

interface PendingWrite {
  sql: string
  args: Bind[]
}

const HIGH_WATER = 500
const FLUSH_MS = 250

let pending: PendingWrite[] = []
let timer: NodeJS.Timeout | null = null

export function enqueueWrite(sql: string, ...args: Bind[]): void {
  pending.push({ sql, args })
  if (pending.length >= HIGH_WATER) {
    flushWrites()
    return
  }
  if (!timer) {
    timer = setTimeout(() => {
      timer = null
      flushWrites()
    }, FLUSH_MS)
  }
}

export function flushWrites(): number {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  if (pending.length === 0) return 0

  const batch = pending
  pending = []

  const db = getDb()
  db.exec('BEGIN')
  try {
    for (const w of batch) prep(w.sql).run(...w.args)
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    // A poisoned batch must not take down the app or silently vanish. Retry each row
    // individually so one bad write doesn't discard the other 499.
    let dropped = 0
    for (const w of batch) {
      try {
        prep(w.sql).run(...w.args)
      } catch {
        dropped++
      }
    }
    console.error(
      `[writer] batch of ${batch.length} failed (${(e as Error).message}); replayed individually, dropped ${dropped}`,
    )
  }
  return batch.length
}

export function pendingWrites(): number {
  return pending.length
}
