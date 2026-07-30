import { spawn, type ChildProcess } from 'node:child_process'
import type { Resolved } from './resolve'

/**
 * Quote a single argument for cmd.exe.
 *
 * Only used on the `.cmd` fallback path (see resolve.ts — we prefer unwrapping the npm shim
 * and spawning node directly). We must never pass `shell: true`: a ticket title containing
 * `&` or `|` would become command injection, and ticket titles come from a language model
 * acting on text from the internet.
 *
 * Rules, in order:
 *   - a run of backslashes immediately before a `"` must be doubled
 *   - `"` is escaped as `\"`
 *   - cmd.exe metacharacters outside quotes are `^`-escaped
 */
export function quoteForCmd(arg: string): string {
  if (arg === '') return '""'

  let out = ''
  let backslashes = 0
  for (const ch of arg) {
    if (ch === '\\') {
      backslashes++
      continue
    }
    if (ch === '"') {
      out += '\\'.repeat(backslashes * 2 + 1) + '"'
      backslashes = 0
      continue
    }
    out += '\\'.repeat(backslashes) + ch
    backslashes = 0
  }
  out += '\\'.repeat(backslashes)

  const quoted = `"${out}"`
  // Escape cmd metacharacters. Inside double quotes cmd still expands %VAR%, so ^-escape it.
  return quoted.replace(/[&|<>^()%!]/g, (m) => '^' + m)
}

export interface SpawnOptions {
  cwd: string
  env?: Record<string, string | undefined>
  /** Extra env applied on top of process.env. */
  extraEnv?: Record<string, string>
}

export function spawnCli(r: Resolved, args: string[], opts: SpawnOptions): ChildProcess {
  const env: Record<string, string | undefined> = {
    ...process.env,
    ...opts.extraEnv,
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    CI: '1',
    DISABLE_AUTOUPDATER: '1',
  }

  // Electron sets this when running a helper as plain Node. If it leaks into a child that
  // is itself node-shaped, the child boots as Electron-as-Node with the wrong argv shape
  // and fails in a way that looks like a corrupt install.
  delete env['ELECTRON_RUN_AS_NODE']

  // vibePilot decides how hard an agent thinks, not the shell it happened to be launched
  // from. Because process.env is spread first, a CLAUDE_CODE_EFFORT_LEVEL or
  // MAX_THINKING_TOKENS set in the user's own environment would otherwise apply to every
  // agent and silently outrank the --effort we just chose per teammate.
  delete env['CLAUDE_CODE_EFFORT_LEVEL']
  delete env['MAX_THINKING_TOKENS']

  /*
   * An agent must be able to compact.
   *
   * Auto-compact is on by default — verified in the shipped CLI: the enabled check is
   * `DISABLE_COMPACT` → `DISABLE_AUTO_COMPACT` → the `autoCompactEnabled` setting, which
   * defaults to true. But the two env vars are read from the raw process environment, not from
   * `--setting-sources`, so a developer who exported one in their shell would silently disable
   * compaction for every agent vibePilot ever spawns. That does not fail loudly: the agent runs
   * until its context is full and then dies, and the cause is a line in a `.bashrc`.
   *
   * `CLAUDE_CODE_AUTO_COMPACT_WINDOW` goes for the same reason as the effort vars above — it
   * overrides the CLI's auto window, which is model-tuned and which the CLI itself flags as
   * "strongly recommended" over a pinned number.
   */
  delete env['DISABLE_COMPACT']
  delete env['DISABLE_AUTO_COMPACT']
  delete env['CLAUDE_CODE_AUTO_COMPACT_WINDOW']

  const isCmd = r.kind === 'cmd'
  const finalArgs = isCmd
    ? [...r.prefix.slice(0, -1), [r.prefix[r.prefix.length - 1]!, ...args].map(quoteForCmd).join(' ')]
    : [...r.prefix, ...args]

  return spawn(r.file, finalArgs, {
    cwd: opts.cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    detached: false,
    shell: false,
    windowsVerbatimArguments: isCmd,
  })
}

/** Ring buffer for stderr — we only ever want the tail, and stderr can be unbounded. */
export class TailBuffer {
  private buf = ''
  constructor(private readonly max = 64 * 1024) {}
  push(s: string): void {
    this.buf += s
    if (this.buf.length > this.max) this.buf = this.buf.slice(-this.max)
  }
  get text(): string {
    return this.buf
  }
  get tail(): string {
    return this.buf.slice(-2000)
  }
}
