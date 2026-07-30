import type { AgentEvent } from '@shared/events'
import { ClaudeCliAdapter } from '../providers/claude/adapter'
import { CodexCliAdapter } from '../providers/codex/adapter'
import type { LaunchSpec, PromptPayload, ProviderAdapter } from '../providers/types'
import { bus } from '../bus'
import { orphanQuestionsForAgent } from '../db/repos/messages'
import { flushWrites } from '../db/writer'
import { askUserGate } from '../mcp/askUser'
import { TurnQueue } from './turnqueue'
import { installTelemetry } from './telemetry'

export interface LiveRun {
  runId: string
  agentId: string
  projectId: string
  adapter: ProviderAdapter
  turns: TurnQueue
  startedAt: number
}

/** Thrown when a launch would give one agent a second process. */
export class AlreadyRunningError extends Error {
  constructor(readonly agentId: string) {
    super(`Agent ${agentId} already has a live process`)
    this.name = 'AlreadyRunningError'
  }
}

/**
 * Owns every live agent process. One instance for the app.
 *
 * Deliberately small: it holds the process table and the shutdown path. Everything about
 * *what* an agent should do lives in the MCP tools and the composed prompt, not here.
 *
 * **One agent, one process.** `byAgent` is keyed by agent id, so a second launch for the same
 * agent used to overwrite the first — leaving a process nobody could reach: `message_agent`
 * could not find it, `agents:stop` could not stop it, and it kept writing to the same agent row
 * from a different worktree until it finished. Refusing here is what makes every 1:1 assumption
 * elsewhere in the codebase actually true.
 */
class AgentManager {
  private runs = new Map<string, LiveRun>()
  private byAgent = new Map<string, string>()

  /**
   * Start a process for an agent. Refuses if that agent already has one.
   * `first` may be null to bring the process up without consuming a turn.
   */
  async launchNow(spec: LaunchSpec, first: PromptPayload | null): Promise<LiveRun> {
    const existing = this.forAgent(spec.agentId)
    if (existing) throw new AlreadyRunningError(spec.agentId)

    // Idempotent. Registering here rather than at app startup means test and future launch
    // paths get telemetry too, without each having to remember to wire it.
    installTelemetry()

    // Branch on the provider exactly once, here. Everything downstream reads capabilities,
    // never a provider name — which is what let Codex drop in without touching the bus, the
    // DB or the UI.
    const adapter: ProviderAdapter =
      spec.provider === 'codex' ? new CodexCliAdapter() : new ClaudeCliAdapter()
    const turns = new TurnQueue((p) => adapter.send(p))

    const run: LiveRun = {
      runId: spec.runId,
      agentId: spec.agentId,
      projectId: spec.projectId,
      adapter,
      turns,
      startedAt: Date.now(),
    }
    this.runs.set(spec.runId, run)
    this.byAgent.set(spec.agentId, spec.runId)

    adapter.onEvent((e: AgentEvent) => {
      // A turn is finished when the CLI reports a result; that unblocks the next one.
      if (e.type === 'agent:done' || e.type === 'agent:error') turns.onTurnComplete()
    })

    void adapter.closed.then(() => {
      this.runs.delete(spec.runId)
      if (this.byAgent.get(spec.agentId) === spec.runId) this.byAgent.delete(spec.agentId)

      /*
       * Close this agent's open questions.
       *
       * This is the one place every ending passes through — clean exit, crash, timeout, app
       * quit — which is why it is the only correct call site. Without it a dead teammate left
       * its question card on screen with working buttons: you answered, the answer was written
       * to the database, and nothing consumed it, because the process that asked no longer
       * existed. `abandon` releases our side of the wait; `orphanQuestionsForAgent` removes the
       * card.
       */
      /*
       * A slot just freed. This is the only correct place: every ending passes through here —
       * clean exit, crash, timeout, app quit — and anywhere else a crashed agent would hold
       * its slot for the life of the app.
       */
      import('./gate').then((g) => g.release(spec.projectId, spec.agentId)).catch(() => {})

      askUserGate.abandon(spec.runId)
      if (orphanQuestionsForAgent(spec.agentId) > 0) {
        flushWrites()
        bus.emitDomain({ type: 'questions:changed', projectId: spec.projectId })
      }
    })

    if (first) turns.markInFlight()
    await adapter.start(spec, first)
    return run
  }

  get(runId: string): LiveRun | undefined {
    return this.runs.get(runId)
  }

  forAgent(agentId: string): LiveRun | undefined {
    const runId = this.byAgent.get(agentId)
    return runId ? this.runs.get(runId) : undefined
  }

  /**
   * Is a turn actually in flight?
   *
   * **Not the same question as `forAgent`,** and conflating the two made a whole class of
   * ticket unrecoverable. `forAgent` answers "does this agent have a run I am holding", which
   * for Claude is the same thing — one process spans the session, so having one means it is
   * there to work. For Codex it is not: a turn *is* a process, the adapter deliberately
   * outlives it, and the run stays registered from the first launch until an explicit stop.
   *
   * So a Codex teammate read as running for ever, and every recovery route checked exactly
   * that flag and refused: `restart_step` said "it is running, nothing is stuck",
   * `assign_teammate` said the step already belonged to someone, and `detectStuckSteps` skipped
   * it entirely — so the automatic heal could never fire either. The Pilot's own account of it:
   * *"Zwei Dinge, die ich nicht kann: den Schritt neu starten, solange vibePilot ihn als
   * laufend führt, und Writer zum sofortigen Handeln zwingen."* Three tools, three refusals, on
   * an agent that had written nothing to disk and was not running at all.
   *
   * `spawning` and `stopping` count as busy: both are moments where interfering is worse than
   * waiting.
   */
  isBusy(agentId: string): boolean {
    const state = this.forAgent(agentId)?.adapter.state
    return state === 'spawning' || state === 'thinking' || state === 'working' || state === 'stopping'
  }

  listByProject(projectId: string): LiveRun[] {
    return [...this.runs.values()].filter((r) => r.projectId === projectId)
  }

  /** Queue a turn. Never writes to stdin directly — see TurnQueue for why. */
  send(agentId: string, payload: PromptPayload): boolean {
    const run = this.forAgent(agentId)
    if (!run) return false
    run.turns.push(payload)
    return true
  }

  async stop(agentId: string, reason: string): Promise<void> {
    const run = this.forAgent(agentId)
    if (!run) return
    await run.adapter.stop(reason)
  }

  async stopProject(projectId: string, reason: string): Promise<void> {
    await Promise.all(
      this.listByProject(projectId).map((r) => r.adapter.stop(reason).catch(() => undefined)),
    )
  }

  async shutdownAll(capMs = 8000): Promise<void> {
    const all = [...this.runs.values()]
    if (all.length === 0) return
    await Promise.race([
      Promise.all(all.map((r) => r.adapter.stop('app quitting').catch(() => undefined))),
      new Promise((r) => setTimeout(r, capMs)),
    ])
  }
}

export const manager = new AgentManager()
