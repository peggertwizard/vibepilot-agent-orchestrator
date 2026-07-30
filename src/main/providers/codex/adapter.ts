import type { ChildProcess } from 'node:child_process'
import type { AgentEvent } from '@shared/events'
import { bus } from '../../bus'
import { createNdjsonReader } from '../process/ndjson'
import { spawnCli, TailBuffer } from '../process/spawn'
import { stopTree } from '../process/kill'
import { resolveCodex } from '../process/resolve'
import type { Resolved } from '../process/resolve'
import { codexArgs, codexEnv } from './argv'
import type { LaunchSpec, PromptPayload, ProviderAdapter, ProviderCapabilities, RunState } from '../types'
import { createCodexState, translateCodex, type CodexTranslatorState } from './translate'

/**
 * Codex, one process per turn.
 *
 * This is the shape the CLI forces, not a choice: `codex exec` runs a turn and exits. There
 * is no stdin channel to write a second turn into. `send()` therefore spawns again with
 * `exec resume <thread>`, and `TurnQueue` upstream already serialises turns, so nothing here
 * has to think about concurrency.
 *
 * Everything about the wire came from `docs/architecture/01-codex-spike.md`, which drove a
 * real process rather than guessing.
 */

export const CODEX_CAPS: ProviderCapabilities = {
  // The reason for everything else on this list.
  persistentTurns: false,
  // No deltas at all: an `agent_message` arrives whole when the turn ends.
  partialText: false,
  thinking: false,
  // Tokens yes (turn.completed.usage), dollars no. We show tokens, so this is survivable.
  nativeCost: false,
  // The thread id is only learned from `thread.started`, after the process is already up.
  preMintableSessionId: false,
  resume: 'subcommand',
  /*
   * HTTP, verified against codex-cli 0.145.0.
   *
   * This said `['stdio']` and the note beside it said Codex "needs a bridge Claude didn't", so
   * the tools were never attached and a Codex teammate could not report its own work. The CLI
   * has `--url` with `--bearer-token-env-var` for streamable-HTTP servers, which is precisely
   * what vibePilot's MCP server already is. There was no bridge to build.
   */
  mcpTransport: ['http'],
  interrupt: 'kill-only',
  /*
   * Still false, but no longer for the reason recorded here.
   *
   * The old note said the helper "is not installed by codex-cli 0.145.0". It is:
   * `codex-windows-sandbox-setup.exe` sits in that release's `codex-resources` directory. What
   * has not been re-observed is whether `-s workspace-write` now actually contains anything, and
   * a sandbox is the one property where assuming in the optimistic direction is unsafe — it
   * would licence treating a Codex teammate as unable to touch the machine.
   *
   * So it stays `false` until a run is watched for `orchestrator_helper_launch_failed`, and the
   * flag is passed regardless: on a platform where the helper works, it is honoured either way.
   */
  sandbox: false,
}

export class CodexCliAdapter implements ProviderAdapter {
  readonly id = 'codex' as const
  readonly caps = CODEX_CAPS

  private proc: ChildProcess | null = null
  private spec: LaunchSpec | null = null
  private st: CodexTranslatorState | null = null
  private stderr = new TailBuffer()
  private listeners = new Set<(e: AgentEvent) => void>()
  private sawResult = false
  private stopping = false
  private binary: Resolved | null = null
  private resolveClosed!: (code: number | null) => void

  state: RunState = 'spawning'
  pid: number | null = null
  sessionId: string | null = null

  readonly closed: Promise<number | null> = new Promise((r) => (this.resolveClosed = r))

  onEvent(fn: (e: AgentEvent) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  async start(spec: LaunchSpec, first: PromptPayload | null): Promise<void> {
    this.spec = spec
    this.binary = await resolveCodex()
    this.sessionId = spec.resumeSessionId ?? null

    if (!this.binary) {
      this.emit({
        ...this.base(),
        type: 'agent:error',
        reason: 'binary_not_found',
        message:
          'Codex was not found. vibePilot runs your own codex executable — install it from ' +
          'OpenAI, or give this teammate a Claude model instead.',
        recoverable: false,
      })
      this.state = 'exited'
      this.resolveClosed(null)
      return
    }

    // Nothing to do until there is a turn: there is no persistent process to warm up. This
    // is the honest version of "started" for a spawn-per-turn provider.
    this.state = 'idle'
    if (first && first.text.trim()) this.send(first)
  }

  /**
   * Each turn is a whole process.
   *
   * The prompt goes over **stdin**, never argv. On Windows a multi-word prompt passed as an
   * argument is split by the shell and rejected as "unexpected argument" — verified in the
   * spike. `codex exec` reads stdin when no prompt argument is given, which sidesteps
   * quoting entirely and handles multi-line prompts for free.
   */
  send(p: PromptPayload): void {
    const spec = this.spec
    if (!spec || !this.binary || this.stopping) return
    if (this.proc && this.state !== 'idle' && this.state !== 'exited') return

    this.st = createCodexState(spec.model)
    this.st.threadId = this.sessionId
    this.sawResult = false
    this.stderr = new TailBuffer()

    const args = codexArgs(spec, this.sessionId)

    try {
      this.proc = spawnCli(this.binary, args, {
        cwd: spec.cwd,
        extraEnv: codexEnv(spec),
      })
    } catch (e) {
      this.emit({
        ...this.base(),
        type: 'agent:error',
        reason: 'spawn_failed',
        message: `Could not start Codex: ${(e as Error).message}`,
        recoverable: false,
      })
      this.state = 'exited'
      this.resolveClosed(null)
      return
    }

    this.pid = this.proc.pid ?? null
    this.state = 'thinking'
    this.wire()

    try {
      // The system prompt has nowhere else to go: Codex has no --append-system-prompt. It
      // is prepended to the turn instead, which costs tokens on every turn — one of the
      // real reasons a Codex teammate is expensive on long work.
      const preamble = this.sessionId ? '' : `${spec.appendSystemPrompt}\n\n---\n\n`
      this.proc.stdin?.write(preamble + p.text)
      this.proc.stdin?.end()
    } catch {
      /* the close handler reports it */
    }
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
          detail: 'Codex printed something that was not JSON. Ignored.',
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
    const events = translateCodex(
      v as never,
      this.st,
      {
        seq: () => bus.nextSeq(),
        projectId: this.spec.projectId,
        agentId: this.spec.agentId,
        runId: this.spec.runId,
        ticketId: this.spec.ticketId,
        parentAgentId: this.spec.parentAgentId,
      },
      this.pid,
    )

    for (const e of events) {
      if (e.type === 'agent:done' || e.type === 'agent:error') this.sawResult = true
      if (e.type === 'agent:tool:start' || e.type === 'agent:text') this.state = 'working'
      this.emit(e)
    }
    // Learned from `thread.started`, and only then. This is why a crash before the first
    // event leaves nothing resumable.
    if (this.st.threadId) this.sessionId = this.st.threadId
  }

  private onClose(code: number | null): void {
    // Exited is the NORMAL resting state here — a turn is a process. Anything queued after
    // this spawns a fresh one.
    this.state = 'idle'

    if (!this.sawResult && !this.stopping) {
      const tail = this.stderr.tail
      const auth = /login|auth|unauthori[sz]ed|not signed in/i.test(tail)
      this.emit({
        ...this.base(),
        type: 'agent:error',
        reason: auth ? 'auth_required' : code === 0 ? 'silent_exit' : 'cli_error',
        message: auth
          ? 'Codex needs you to sign in. Run `codex` in a terminal once, then try again.'
          : code === 0
            ? 'Codex exited without completing a turn.'
            : `Codex exited with code ${code}.`,
        detail: tail || undefined,
        recoverable: true,
      })
    } else if (this.stopping) {
      this.state = 'exited'
      this.emit({
        ...this.base(),
        type: 'agent:done',
        terminal: 'killed',
        stopReason: null,
        numTurns: 0,
        durationMs: 0,
      })
      this.resolveClosed(code)
    }
  }

  async interrupt(): Promise<'interrupted' | 'unsupported'> {
    return 'unsupported'
  }

  async stop(reason: string, graceMs = 5000): Promise<void> {
    this.stopping = true
    this.state = 'stopping'
    if (this.proc) await stopTree(this.proc, graceMs)
    else {
      // Idle between turns: there is no process to kill, so resolve the lifetime here or
      // the manager waits forever on a promise nothing will settle.
      this.state = 'exited'
      this.resolveClosed(null)
    }
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
