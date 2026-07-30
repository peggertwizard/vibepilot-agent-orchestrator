import { describe, expect, it, vi } from 'vitest'
import { quoteForCmd, spawnCli } from '../src/main/providers/process/spawn'
import { createNdjsonReader } from '../src/main/providers/process/ndjson'

/**
 * Ticket titles come from a language model acting on text it read from the internet, and
 * they end up on a command line. If `shell: true` were ever set, or quoting were wrong,
 * `Fix "cart" & drop tables` becomes command execution.
 */
describe('quoteForCmd', () => {
  it('wraps plain text', () => {
    expect(quoteForCmd('hello')).toBe('"hello"')
  })

  it('escapes cmd metacharacters', () => {
    for (const ch of ['&', '|', '<', '>', '^', '(', ')', '%']) {
      const out = quoteForCmd(`a${ch}b`)
      expect(out).toContain('^' + ch)
    }
  })

  it('doubles backslashes before a quote', () => {
    // C:\path\ + " would otherwise escape the closing quote and break argument parsing.
    expect(quoteForCmd('a\\"b')).toBe('"a\\\\\\"b"')
  })

  it('preserves a trailing backslash', () => {
    expect(quoteForCmd('C:\\dir\\')).toBe('"C:\\dir\\"')
  })

  it('handles an empty string', () => {
    expect(quoteForCmd('')).toBe('""')
  })

  it('neutralises an injection attempt in a ticket title', () => {
    const out = quoteForCmd('Fix cart" & del /f /q C:\\ &')
    expect(out).not.toMatch(/(^|[^^])&/)
  })
})

describe('ndjson reader', () => {
  it('parses whole lines and strips CR', () => {
    const seen: unknown[] = []
    const r = createNdjsonReader({ onValue: (v) => seen.push(v) })
    r.push(Buffer.from('{"a":1}\r\n{"b":2}\n'))
    expect(seen).toEqual([{ a: 1 }, { b: 2 }])
  })

  it('joins a value split across chunks', () => {
    const seen: unknown[] = []
    const r = createNdjsonReader({ onValue: (v) => seen.push(v) })
    r.push(Buffer.from('{"long":"he'))
    r.push(Buffer.from('llo"}\n'))
    expect(seen).toEqual([{ long: 'hello' }])
  })

  it('does not mangle a multi-byte character split across chunks', () => {
    // The naive chunk.toString() implementation produces mojibake here. This is the whole
    // reason the reader uses StringDecoder.
    const seen: Record<string, string>[] = []
    const r = createNdjsonReader({ onValue: (v) => seen.push(v as Record<string, string>) })
    const full = Buffer.from('{"s":"café ☕"}\n', 'utf8')
    const cut = 11 // lands inside the multi-byte é
    r.push(full.subarray(0, cut))
    r.push(full.subarray(cut))
    expect(seen[0]?.['s']).toBe('café ☕')
  })

  it('reports garbage without throwing', () => {
    const garbage: string[] = []
    const seen: unknown[] = []
    const r = createNdjsonReader({ onValue: (v) => seen.push(v), onGarbage: (l) => garbage.push(l) })
    r.push(Buffer.from('SessionEnd hook failed\n{"ok":true}\n'))
    expect(garbage).toEqual(['SessionEnd hook failed'])
    expect(seen).toEqual([{ ok: true }])
  })

  it('caps a runaway line instead of exhausting memory', () => {
    const onOverflow = vi.fn()
    const r = createNdjsonReader({ onValue: () => undefined, onOverflow, maxLineBytes: 64 })
    r.push(Buffer.from('x'.repeat(200)))
    expect(onOverflow).toHaveBeenCalled()
  })

  it('flushes a trailing line without a newline on end', () => {
    const seen: unknown[] = []
    const r = createNdjsonReader({ onValue: (v) => seen.push(v) })
    r.push(Buffer.from('{"tail":1}'))
    r.end()
    expect(seen).toEqual([{ tail: 1 }])
  })
})

/**
 * What the shell vibePilot happened to be launched from must not decide how agents behave.
 *
 * `process.env` is spread into every spawn, so anything a developer exported in their shell
 * reaches every agent. Some of those variables fail loudly; the compaction ones do not — an
 * agent with auto-compact disabled simply runs until its context is full and then dies, and
 * the cause is one line in a `.bashrc` nowhere near the crash.
 */
describe('spawn environment', () => {
  const readEnv = async (names: string[]): Promise<Record<string, string | undefined>> => {
    const child = spawnCli(
      { kind: 'exe', file: process.execPath, prefix: [], source: 'test' },
      ['-e', `process.stdout.write(JSON.stringify(process.env))`],
      { cwd: process.cwd(), extraEnv: Object.fromEntries(names.map((n) => [n, 'set-by-the-shell'])) },
    )
    let out = ''
    child.stdout?.on('data', (c: Buffer) => (out += c.toString()))
    await new Promise((r) => child.on('close', r))
    const env = JSON.parse(out) as Record<string, string | undefined>
    return Object.fromEntries(names.map((n) => [n, env[n]]))
  }

  it('never lets the shell disable compaction or pin the window', async () => {
    const env = await readEnv([
      'DISABLE_COMPACT',
      'DISABLE_AUTO_COMPACT',
      'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
    ])
    expect(env['DISABLE_COMPACT']).toBeUndefined()
    expect(env['DISABLE_AUTO_COMPACT']).toBeUndefined()
    // The CLI's auto window is model-tuned and it recommends it over any pinned number.
    expect(env['CLAUDE_CODE_AUTO_COMPACT_WINDOW']).toBeUndefined()
  })

  it('never lets the shell outrank the effort vibePilot chose', async () => {
    const env = await readEnv(['CLAUDE_CODE_EFFORT_LEVEL', 'MAX_THINKING_TOKENS'])
    expect(env['CLAUDE_CODE_EFFORT_LEVEL']).toBeUndefined()
    expect(env['MAX_THINKING_TOKENS']).toBeUndefined()
  })
})
