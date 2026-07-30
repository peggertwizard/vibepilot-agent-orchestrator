import type { ChildProcess } from 'node:child_process'
import type { AgentEvent } from '@shared/events'
import { bus } from '../../bus'
import { createNdjsonReader } from '../process/ndjson'
import { resolveClaude } from '../process/resolve'
import { spawnCli, TailBuffer } from '../process/spawn'
import { stopTree } from '../process/kill'
import { CLAUDE_CAPS, type LaunchSpec, type PromptPayload, type ProviderAdapter, type RunState } from '../types'
import { buildClaudeArgv, redactArgv } from './argv'
import { createTranslatorState, translate, type TranslatorState } from './translate'

/**
 * One Claude Code process. Long-lived: turns are written to stdin, so we pay the ~5s cold
 * start once instead of per turn (turn 2 onwards is ~2s).
 */
export class ClaudeCliAdapter implements ProviderAdapter {
  readonly id = 'claude' as const
  readonly caps = CLAUDE_CAPS

  private proc: ChildProcess | null = null
  private st: TranslatorState | null = null
  private spec: LaunchSpec | null = null
  private stderr = new TailBuffer()
  private listeners = new Set<(e: AgentEvent) => void>()
  private sawResult = false
  private stopping = false
  private resolveClosed!: (code: number | null) => void

  state: RunState = 'spawning'
  pid: number | null = null
  sessionId: string | null = null
  argv: string[] = []

  readonly closed: Promise<number | null> = new Promise((r) => (this.resolveClosed = r))

  onEvent(fn: (e: AgentEvent) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  async start(spec: LaunchSpec, first: PromptPayload | null): Promise<void> {
    this.spec = spec
    this.sessionId = spec.resumeSessionId ?? spec.sessionId

    const resolved = await resolveClaude()
    if (!resolved) {
      this.emit({
        ...this.base(),
        type: 'agent:error',
        reason: 'binary_not_found',
        message:
          'Claude Code was not found. vibePilot runs your own claude executable — install it, ' +
          'or set the path in Settings.',
        recoverable: false,
      })
      this.state = 'exited'
      this.resolveClosed(null)
      return
    }

    const args = buildClaudeArgv(spec)
    this.argv = redactArgv(args)
    this.st = createTranslatorState(this.sessionId, spec.model)

    try {
      this.proc = spawnCli(resolved, args, {
        cwd: spec.cwd,
        extraEnv: {
          VIBEPILOT_RUN_ID: spec.runId,
          ...(spec.mcp ? { VIBEPILOT_MCP_URL: spec.mcp.url } : {}),
        },
      })
    } catch (e) {
      this.emit({
        ...this.base(),
        type: 'agent:error',
        reason: 'spawn_failed',
        message: `Could not start Claude Code: ${(e as Error).message}`,
        recoverable: false,
      })
      this.state = 'exited'
      this.resolveClosed(null)
      return
    }

    this.pid = this.proc.pid ?? null
    this.wire()
    if (first && first.text.trim()) this.send(first)
  }

  private wire(): void {
    const proc = this.proc!
    const reader = createNdjsonReader({
      onValue: (v) => this.onWire(v),
      onGarbage: () => {
        this.emit({
          ...this.base(),
          type: 'agent:degraded',
          reason: 'noisy_stdout',
          detail: 'The CLI printed something that was not JSON. Ignored.',
        })
      },
      onOverflow: (bytes) => {
        this.emit({
          ...this.base(),
          type: 'agent:error',
          reason: 'stream_overflow',
          message: `A single output line exceeded ${Math.round(bytes / 1024 / 1024)} MB. Stopping this agent.`,
          recoverable: true,
        })
        void this.kill('stream_overflow')
      },
    })

    proc.stdout?.on('data', (c: Buffer) => reader.push(c))
    proc.stdout?.on('end', () => reader.end())
    proc.stderr?.on('data', (c: Buffer) => this.stderr.push(c.toString()))

    proc.on('error', (e) => {
      this.emit({
        ...this.base(),
        type: 'agent:error',
        reason: 'spawn_failed',
        message: e.message,
        recoverable: false,
      })
    })

    proc.on('close', (code) => this.onClose(code))
  }

  private onWire(v: unknown): void {
    if (!this.st || !this.spec) return
    const events = translate(v as never, this.st, {
      seq: () => bus.nextSeq(),
      projectId: this.spec.projectId,
      agentId: this.spec.agentId,
      runId: this.spec.runId,
      ticketId: this.spec.ticketId,
      parentAgentId: this.spec.parentAgentId,
      provider: 'claude',
    }, this.pid)

    for (const e of events) {
      if (e.type === 'agent:done' || e.type === 'agent:error') this.sawResult = true
      this.trackState(e)
      this.emit(e)
    }
    if (this.sessionId !== this.st.sessionId) this.sessionId = this.st.sessionId
  }

  private trackState(e: AgentEvent): void {
    if (this.stopping) return
    switch (e.type) {
      case 'agent:started':
        this.state = 'idle'
        break
      case 'agent:thinking':
        this.state = 'thinking'
        break
      case 'agent:text':
      case 'agent:tool:start':
      case 'agent:tool:end':
        this.state = 'working'
        break
      case 'agent:question':
        this.state = 'waiting_on_you'
        break
      case 'agent:done':
        this.state = 'idle'
        break
    }
  }

  private onClose(code: number | null): void {
    this.state = 'exited'

    if (!this.sawResult && !this.stopping) {
      // Exited without ever producing a `result`. Without this branch the agent sits at
      // "starting" forever and nobody can tell it died.
      const tail = this.stderr.tail
      const auth = /login|authenticate|oauth|unauthori[sz]ed/i.test(tail)
      this.emit({
        ...this.base(),
        type: 'agent:error',
        reason: auth ? 'auth_required' : code === 0 ? 'silent_exit' : 'cli_error',
        message: auth
          ? 'Claude Code needs you to sign in. Run `claude` in a terminal once, then try again.'
          : code === 0
            ? 'Claude Code exited without producing a result.'
            : `Claude Code exited with code ${code}.`,
        detail: tail || undefined,
        recoverable: true,
      })
    } else if (this.stopping) {
      this.emit({
        ...this.base(),
        type: 'agent:done',
        terminal: 'killed',
        stopReason: null,
        numTurns: 0,
        durationMs: 0,
      })
    }

    this.resolveClosed(code)
  }

  send(p: PromptPayload): void {
    if (!this.proc?.stdin || this.proc.stdin.destroyed) return
    const content: Array<Record<string, unknown>> = [{ type: 'text', text: p.text }]
    for (const img of p.images ?? []) {
      content.unshift({
        type: 'image',
        source: { type: 'base64', media_type: img.mediaType, data: img.base64 },
      })
    }
    this.sawResult = false
    try {
      this.proc.stdin.write(
        JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n',
      )
    } catch {
      /* the close handler will report it */
    }
  }

  /**
   * Not supported. `control_request/interrupt` on stdin was verified to be ignored in
   * 2.1.220; the only reliable stop is killing the tree, which costs the in-flight turn.
   */
  async interrupt(): Promise<'interrupted' | 'unsupported'> {
    return 'unsupported'
  }

  async stop(reason: string, graceMs = 5000): Promise<void> {
    if (!this.proc || this.state === 'exited') return
    this.stopping = true
    this.state = 'stopping'
    await stopTree(this.proc, graceMs)
    void reason
  }

  async kill(reason: string): Promise<void> {
    await this.stop(reason, 0)
  }

  private emit(e: AgentEvent): void {
    for (const fn of this.listeners) fn(e)
    bus.emitAgent(e)
  }

  private base() {
    const s = this.spec
    return {
      seq: bus.nextSeq(),
      ts: Date.now(),
      projectId: s?.projectId ?? '',
      agentId: s?.agentId ?? '',
      runId: s?.runId ?? '',
      ticketId: s?.ticketId ?? null,
      parentAgentId: s?.parentAgentId ?? null,
    }
  }
}
