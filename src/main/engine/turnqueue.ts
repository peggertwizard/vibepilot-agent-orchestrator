import type { PromptPayload } from '../providers/types'

/**
 * Serialises turns into one persistent stdin session.
 *
 * A Claude process handles exactly one turn at a time, but turns arrive from three
 * directions: the composer, teammate notifications, and answers to questions. Writing a
 * second line while a turn is in flight corrupts the conversation, so everything funnels
 * through here.
 *
 * The coalescing rule is deliberate and asymmetric:
 *   - consecutive `system-notice` payloads MERGE, so three teammates finishing inside ten
 *     seconds cost one Pilot turn instead of three
 *   - a `user` payload NEVER merges with anything — what you typed reaches the Pilot
 *     verbatim and alone, in its own turn
 */
export class TurnQueue {
  private q: PromptPayload[] = []
  private inFlight = false

  constructor(private readonly write: (p: PromptPayload) => void) {}

  get depth(): number {
    return this.q.length
  }
  get busy(): boolean {
    return this.inFlight
  }

  /** The first prompt is written by `adapter.start`, so the queue starts occupied. */
  markInFlight(): void {
    this.inFlight = true
  }

  push(p: PromptPayload): void {
    this.q.push(p)
    this.pump()
  }

  onTurnComplete(): void {
    this.inFlight = false
    this.pump()
  }

  private pump(): void {
    if (this.inFlight || this.q.length === 0) return
    const next = this.drainCoalesced()
    if (!next) return
    this.inFlight = true
    this.write(next)
  }

  private drainCoalesced(): PromptPayload | null {
    const head = this.q.shift()
    if (!head) return null
    if (head.channel !== 'system-notice') return head

    const parts = [head.text]
    while (this.q[0]?.channel === 'system-notice') {
      parts.push(this.q.shift()!.text)
    }
    return { ...head, text: parts.join('\n\n') }
  }
}

/**
 * Frame a notice so the Pilot can never mistake machine chatter for something the user
 * said. The tag is explicit rather than a bare paragraph for exactly that reason.
 */
export function notice(body: string): PromptPayload {
  return { text: `<vibepilot-notice>\n${body}\n</vibepilot-notice>`, channel: 'system-notice' }
}
