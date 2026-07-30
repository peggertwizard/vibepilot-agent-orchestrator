import type { BrowserWindow } from 'electron'
import type { AgentEvent, BusBatch, DomainEvent } from '@shared/events'
import { bus } from './index'

/**
 * Batches bus traffic to the renderer over one IPC channel.
 *
 * Token-level deltas arrive at ~200/s per agent. Forwarding each one is ~200 IPC messages
 * per second per agent; at 20 Hz a human cannot tell the difference, and it turns that into
 * 20. Deltas for one text block are contiguous, so a coalesced delta is emitted at the
 * position of its last fragment, which preserves ordering.
 */

const FLUSH_MS = 50
const MAX_BATCH_BYTES = 256 * 1024

interface Accum {
  event: AgentEvent
  text: string
}

export class Coalescer {
  private buf: AgentEvent[] = []
  private domain: DomainEvent[] = []
  private deltas = new Map<string, Accum>()
  private timer: NodeJS.Timeout | null = null
  private truncated = false
  private win: BrowserWindow | null = null
  private unsub: Array<() => void> = []

  attach(win: BrowserWindow): void {
    this.win = win
    this.unsub.push(bus.onAgent((e) => this.pushAgent(e)))
    this.unsub.push(bus.onDomain((e) => this.pushDomain(e)))
  }

  detach(): void {
    for (const u of this.unsub) u()
    this.unsub = []
    this.win = null
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private pushAgent(e: AgentEvent): void {
    if (e.type === 'agent:text' && e.delta !== undefined && e.final === undefined) {
      const key = `${e.agentId}:${e.blockIndex}`
      const prev = this.deltas.get(key)
      if (prev) {
        prev.text += e.delta
        prev.event = e
      } else {
        this.deltas.set(key, { event: e, text: e.delta })
      }
    } else if (e.type === 'agent:thinking' && e.delta !== undefined) {
      const key = `think:${e.agentId}:${e.blockIndex ?? 0}`
      const prev = this.deltas.get(key)
      if (prev) {
        prev.text += e.delta
        prev.event = e
      } else {
        this.deltas.set(key, { event: e, text: e.delta })
      }
    } else {
      // Flush accumulated deltas before a structural event so ordering stays truthful.
      this.drainDeltas()
      this.buf.push(e)
    }
    this.arm()
  }

  private pushDomain(e: DomainEvent): void {
    // Collapse duplicate domain notifications within a window — the renderer refetches
    // wholesale, so three "tickets:changed" in 50ms is exactly as informative as one.
    if (!this.domain.some((d) => d.type === e.type && sameProject(d, e))) {
      this.domain.push(e)
    }
    this.arm()
  }

  private drainDeltas(): void {
    for (const acc of this.deltas.values()) {
      const e = acc.event
      if (e.type === 'agent:text') this.buf.push({ ...e, delta: acc.text })
      else if (e.type === 'agent:thinking') this.buf.push({ ...e, delta: acc.text })
    }
    this.deltas.clear()
  }

  private arm(): void {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.flush()
    }, FLUSH_MS)
  }

  flush(): void {
    this.drainDeltas()
    if (this.buf.length === 0 && this.domain.length === 0) return

    const win = this.win
    if (!win || win.isDestroyed() || !win.webContents || win.webContents.isLoading()) {
      // Renderer isn't ready. Drop text deltas only — never lifecycle or tool events —
      // and let the renderer re-snapshot from SQLite, the single source of truth.
      this.dropDeltasOnly()
      return
    }

    let events = this.buf
    let bytes = roughBytes(events)
    if (bytes > MAX_BATCH_BYTES) {
      events = events.filter((e) => !(e.type === 'agent:text' && e.final === undefined))
      this.truncated = true
      bytes = roughBytes(events)
    }

    const batch: BusBatch = { events, domain: this.domain, truncated: this.truncated }
    this.buf = []
    this.domain = []
    this.truncated = false

    try {
      win.webContents.send('bus:event', batch)
    } catch {
      /* window went away mid-send; next snapshot reconciles */
    }
  }

  private dropDeltasOnly(): void {
    const kept = this.buf.filter((e) => !(e.type === 'agent:text' && e.final === undefined))
    if (kept.length !== this.buf.length) this.truncated = true
    this.buf = kept
  }
}

function sameProject(a: DomainEvent, b: DomainEvent): boolean {
  return (a as { projectId?: string }).projectId === (b as { projectId?: string }).projectId
}

function roughBytes(events: AgentEvent[]): number {
  let n = 0
  for (const e of events) {
    n += 120
    if ('delta' in e && typeof e.delta === 'string') n += e.delta.length
    if ('final' in e && typeof e.final === 'string') n += e.final.length
    if ('raw' in e && typeof e.raw === 'string') n += e.raw.length
  }
  return n
}

export const coalescer = new Coalescer()
