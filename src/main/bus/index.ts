import { EventEmitter } from 'node:events'
import type { AgentEvent, BusBatch, DomainEvent } from '@shared/events'

/**
 * The single event spine. Adapters emit here; the coalescer batches to the renderer; repos
 * and the engine subscribe for side effects.
 *
 * `seq` is allocated synchronously at emit so ordering is total and stable even when
 * several agents interleave.
 */
class Bus extends EventEmitter {
  private seqCounter = 0

  nextSeq(): number {
    return ++this.seqCounter
  }

  emitAgent(e: AgentEvent): void {
    this.emit('agent', e)
    this.emit(e.type, e)
  }

  emitDomain(e: DomainEvent): void {
    this.emit('domain', e)
  }

  onAgent(fn: (e: AgentEvent) => void): () => void {
    this.on('agent', fn)
    return () => this.off('agent', fn)
  }

  onDomain(fn: (e: DomainEvent) => void): () => void {
    this.on('domain', fn)
    return () => this.off('domain', fn)
  }
}

export const bus = new Bus()
// Many subscribers per agent run; the default 10 is far too low and produces noise.
bus.setMaxListeners(200)

export type { AgentEvent, BusBatch, DomainEvent }
