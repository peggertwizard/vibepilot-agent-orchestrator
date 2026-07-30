import { StringDecoder } from 'node:string_decoder'

/**
 * Line-delimited JSON reader for a child's stdout.
 *
 * Two things here are load-bearing:
 *
 * 1. `StringDecoder`, not `chunk.toString()`. A multi-byte UTF-8 character split across a
 *    chunk boundary turns into mojibake with the naive version, and it happens constantly
 *    once an agent prints a box-drawing character or an emoji.
 * 2. Garbage tolerance. The CLI occasionally writes non-JSON to stdout (hook noise,
 *    updater chatter). That must degrade, never kill the run.
 */
export interface NdjsonHandlers {
  onValue: (v: unknown) => void
  onGarbage?: (line: string) => void
  onOverflow?: (bytes: number) => void
  maxLineBytes?: number
}

const DEFAULT_MAX_LINE = 16 * 1024 * 1024

export function createNdjsonReader(h: NdjsonHandlers) {
  const decoder = new StringDecoder('utf8')
  const max = h.maxLineBytes ?? DEFAULT_MAX_LINE
  let tail = ''
  let overflowed = false

  return {
    push(chunk: Buffer): void {
      if (overflowed) return
      tail += decoder.write(chunk)

      if (tail.length > max) {
        overflowed = true
        h.onOverflow?.(tail.length)
        tail = ''
        return
      }

      let nl = tail.indexOf('\n')
      while (nl !== -1) {
        const raw = tail.slice(0, nl)
        tail = tail.slice(nl + 1)
        emit(raw)
        nl = tail.indexOf('\n')
      }
    },

    /** Flush whatever is left; call on stream end. */
    end(): void {
      tail += decoder.end()
      if (tail.trim()) emit(tail)
      tail = ''
    },
  }

  function emit(raw: string): void {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (!line.trim()) return
    try {
      h.onValue(JSON.parse(line))
    } catch {
      h.onGarbage?.(line)
    }
  }
}
