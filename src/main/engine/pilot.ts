import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { AgentEvent } from '@shared/events'
import type { Attachment, MessageUsage, Project, ToolSummary } from '@shared/types'
import { effortDefaultFor } from '@shared/types'
import { bus } from '../bus'
import { id, now } from '../db'
import { enqueueWrite, flushWrites } from '../db/writer'
import {
  createAgent,
  getAgent,
  getPilot,
  listAgents,
  setAgentSession,
  setAgentStatus,
  updateAgent,
} from '../db/repos/agents'
import { addMessage } from '../db/repos/messages'
import { listRoutes } from '../db/repos/routes'
import { listTickets, listOpenDrafts } from '../db/repos/tickets'
import { getProject } from '../db/repos/projects'
import { mcpServer } from '../mcp/server'
import { attachmentsDir } from '../paths'
import { manager } from './manager'
import { placeAll } from './board'
import { liveTouches, renderTouches } from './overlap'
import { buildPilotPrompt, liveBoardBlock, ensureProjectConfig } from './context'
import { noteSessionChange } from './session'
import type { LaunchSpec, PromptPayload } from '../providers/types'

/**
 * The Pilot: one long-lived Claude process per open project.
 *
 * Started lazily on the first message and kept warm — a cold start costs ~5s and ~4k
 * cache-creation tokens, so restarting per turn would be both slow and expensive.
 */

/**
 * The Pilot may not write code. This single restriction does more for output quality than
 * any amount of prompt wording: it forces planning and delegation instead of the model
 * quietly doing the work itself and leaving the board untouched.
 */
/** Tool detail attached to one message, across all its steps. ~16 KB. */
const DETAIL_BUDGET = 16_384

const PILOT_DISALLOWED = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']
const PILOT_ALLOWED = [
  'Read',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
  'TodoWrite',
  'Task',
  'Bash(git log:*)',
  'Bash(git status:*)',
  'Bash(git diff:*)',
  'Bash(git branch:*)',
  'mcp__vibepilot__*',
]

interface TextAccum {
  messageId: string | null
  text: string
}

class PilotService {
  private starting = new Map<string, Promise<string>>()
  private accum = new Map<string, TextAccum>()
  private pendingTools = new Map<string, ToolSummary[]>()
  /**
   * The turn's cost, held until the message it paid for is written.
   *
   * `agent:cost` provably arrives before `agent:done` (translate.ts emits both from the
   * same `result` message, cost first), and flushTurn runs on done — so there is no
   * reconciliation problem and no need for a second pass.
   */
  private pendingCost = new Map<string, MessageUsage>()
  /** tool_use_id -> its input, held until the matching result arrives. */
  private pendingInputs = new Map<string, string>()
  /** Bytes of tool detail attached to the current turn, against DETAIL_BUDGET. */
  private detailBytes = new Map<string, number>()

  /** Ensure a Pilot agent row exists and a process is running. Returns the agent id. */
  async ensure(projectId: string, model: string): Promise<string> {
    const existing = this.starting.get(projectId)
    if (existing) return existing

    const p = (async () => {
      const project = getProject(projectId)
      if (!project) throw new Error('Project not found')

      let pilot = getPilot(projectId)
      if (!pilot) {
        pilot = createAgent({
          projectId,
          name: 'Pilot',
          role: 'pilot',
          provider: 'claude',
          model,
          isPilot: true,
          ephemeral: false,
          status: 'idle',
        })
        bus.emitDomain({ type: 'agents:changed', projectId })
      }

      if (manager.forAgent(pilot.id)) return pilot.id

      /*
       * Say it is waking up before the slow part, not after it.
       *
       * The first status write lived inside `launch`, after the MCP bind and the token mint —
       * so from the outside the Pilot sat at `idle` through the entire cold start and only
       * announced itself once it was nearly ready. Everything downstream keys on this status:
       * the composer's busy state, the agents rail, and the row that shows what it is doing.
       */
      setAgentStatus(pilot.id, 'starting', 'Waking up')
      flushWrites()
      bus.emitDomain({ type: 'agents:changed', projectId })

      ensureProjectConfig(project.path)
      await this.launch(project, pilot.id, model)
      return pilot.id
    })()

    this.starting.set(projectId, p)
    try {
      return await p
    } finally {
      this.starting.delete(projectId)
    }
  }

  private async launch(project: Project, agentId: string, model: string): Promise<void> {
    const port = await mcpServer.listen()
    void port

    const runId = id()
    const sessionId = randomUUID()

    /*
     * The row has to claim the model it is actually about to run.
     *
     * `ensure` writes `model` only when it *creates* the Pilot, and the composer's model
     * picker writes `project.pilotModel` — nothing ever updated the row. So a Pilot created
     * on Sonnet and thereafter run on Opus kept `model: 'sonnet'` for ever, while telemetry
     * faithfully stamped `resolved_model: 'claude-opus-5'` on the same row. That pair is the
     * seed the model picker learns from, and it is why the Sonnet chip read "Opus 5".
     *
     * `updateAgent` clears the stale resolution on a real change, so this heals it once.
     */
    const before = getAgent(agentId)
    if (before && before.model !== model) updateAgent(agentId, { model })
    const agent = getAgent(agentId)

    const token = mcpServer.mintToken({
      runId,
      agentId,
      projectId: project.id,
      ticketId: null,
      role: 'pilot',
    })

    const spec: LaunchSpec = {
      runId,
      provider: 'claude',
      // The Pilot orchestrates rather than solves, so it does not need to think its hardest
      // by default — but you can raise it, and it is the one agent you talk to directly.
      effort: getAgent(agentId)?.effort ?? effortDefaultFor('pilot'),
      agentId,
      projectId: project.id,
      ticketId: null,
      parentAgentId: null,
      cwd: project.path,
      // So the Pilot can Read anything the user attached; the files live in userData.
      addDirs: [attachmentsDir()],
      model,
      appendSystemPrompt: buildPilotPrompt({
        project,
        touching: renderTouches(await liveTouches(project.id)),
        // The Pilot is shown the same board the user is, stalls included. It cannot be asked
        // to notice that nothing is progressing while being handed a lane that says it is.
        tickets: placeAll(listTickets(project.id)),
        agents: listAgents(project.id),
        routes: listRoutes(project.id),
      }),
      permissionMode: 'bypassPermissions',
      trustProjectSettings: project.settingsTrusted,
      allowedTools: PILOT_ALLOWED,
      disallowedTools: PILOT_DISALLOWED,
      mcp: { url: mcpServer.url, token },
      // Resume only works from the same cwd, and the Pilot's cwd is the project root, which
      // is stable — so resuming a previous Pilot session is safe here.
      sessionId,
      resumeSessionId: agent?.sessionId ?? null,
    }

    // Persist before spawn: a crash before the first system/init must still leave a handle.
    setAgentSession(agentId, agent?.sessionId ?? sessionId)
    setAgentStatus(agentId, 'starting', 'Waking up')
    enqueueWrite(
      `INSERT INTO agent_runs (id, agent_id, project_id, provider, session_id, resumed_from, cwd, started_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      runId,
      agentId,
      project.id,
      'claude',
      sessionId,
      agent?.sessionId ?? null,
      project.path,
      now(),
    )
    bus.emitDomain({ type: 'agents:changed', projectId: project.id })

    this.subscribe(project.id, agentId, runId)

    // Start the process with no first turn — the caller queues the real one immediately
    // after. An empty prompt would burn a turn and confuse the model.
    await manager.launchNow(spec, null)
  }

  /** Persist the stream into messages/costs and keep the agent row honest. */
  private subscribe(projectId: string, agentId: string, runId: string): void {
    const key = `${agentId}`
    const off = bus.onAgent((e: AgentEvent) => {
      if (e.agentId !== agentId) return

      switch (e.type) {
        case 'agent:started':
          setAgentStatus(agentId, 'thinking', 'Reading the project')
          setAgentSession(agentId, e.sessionId)
          if (!e.mcpOk) {
            addMessage({
              projectId,
              agentId,
              authorType: 'system',
              kind: 'error',
              body:
                'The vibePilot bridge did not connect, so the Pilot cannot create tickets or ' +
                'spawn teammates this session. Restarting usually fixes it.',
            })
            bus.emitDomain({ type: 'messages:changed', projectId })
          }
          bus.emitDomain({ type: 'agents:changed', projectId })
          break

        case 'agent:thinking':
          if (e.phase === 'compacting') {
            setAgentStatus(agentId, 'thinking', 'Summarising the conversation to make room')
          } else if (!e.delta) {
            // Leave the status line alone. It used to be overwritten with the literal word
            // "Thinking" at the start of every request, which would wipe whatever the Pilot
            // had just said it was doing — the `status` tool would work once and then be
            // erased a second later.
            setAgentStatus(agentId, 'thinking')
          }
          break

        case 'agent:text':
          if (e.final !== undefined) {
            // The assembled message is authoritative; deltas were display only.
            const acc = this.accum.get(key)
            this.accum.set(key, { messageId: e.messageId, text: (acc?.text ?? '') + e.final })
          }
          setAgentStatus(agentId, 'working', null)
          break

        case 'agent:tool:start':
          // ONLY when there is an input. The streaming tool:start fires first with none and
          // the assembled one second with it; an unconditional set would clobber the good
          // value if that order ever flipped.
          if (typeof e.input === 'string' && e.input) this.pendingInputs.set(e.toolUseId, e.input)

          /*
           * The Pilot's status line is NOT the name of its last tool.
           *
           * It used to be, which is how the one place a person looks to see what is happening
           * came to read `bash`. Worse, it stuck: once the Pilot delegates it has nothing to
           * do, so whatever it happened to touch last stayed on screen for as long as the
           * teammate ran. Nothing could turn a command line into intent without guessing —
           * the Pilot knows, so it is asked, via the `status` tool.
           *
           * Teammates keep the tool-name line. In the watch drawer "ran a command" is exactly
           * what you want to see, because there you are watching the work, not the plan.
           */
          bus.emitDomain({ type: 'agents:changed', projectId })
          break

        case 'agent:tool:end': {
          const list = this.pendingTools.get(key) ?? []
          const input = this.pendingInputs.get(e.toolUseId)
          this.pendingInputs.delete(e.toolUseId)

          // Per-message ceiling. Individual caps bound one step; this bounds a turn that
          // makes forty of them, which is what would actually bloat the row.
          const spent = this.detailBytes.get(key) ?? 0
          const cost = (input?.length ?? 0) + (e.raw?.length ?? 0)
          const room = spent + cost <= DETAIL_BUDGET
          this.detailBytes.set(key, spent + (room ? cost : 0))

          list.push({
            toolUseId: e.toolUseId,
            name: e.name,
            summary: e.summary,
            durationMs: e.durationMs,
            isError: e.isError,
            // Carried through so the log can indent it. The translator already tags this
            // from `parent_tool_use_id`; v1 threw it away here and the UI never saw it.
            subagentOf: e.subagentOf ?? null,
            input: room ? input : undefined,
            output: room ? e.raw : undefined,
            truncated: room ? e.truncated : true,
          })
          this.pendingTools.set(key, list)
          break
        }

        // Agent-level usage is persisted centrally in engine/telemetry.ts. This row is the
        // per-turn audit trail, which is a different thing.
        case 'agent:cost':
          this.pendingCost.set(key, {
            inputTokens: e.inputTokens,
            outputTokens: e.outputTokens,
            cacheReadTokens: e.cacheReadTokens,
            cacheCreationTokens: e.cacheCreationTokens,
          })
          enqueueWrite(
            `INSERT INTO usage_events
               (id, project_id, agent_id, run_id, provider, model, input_tokens, output_tokens,
                cache_read_tokens, cache_creation_tokens, cost_usd, cost_source, created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            id(), projectId, agentId, runId, 'claude', e.model,
            e.inputTokens, e.outputTokens, e.cacheReadTokens, e.cacheCreationTokens,
            e.costUsd, e.costSource, now(),
          )
          break

        case 'agent:done': {
          this.flushTurn(projectId, agentId, runId)
          setAgentStatus(agentId, 'idle', e.summary ?? null)
          noteSessionChange(projectId, agentId, e.sessionId)
          bus.emitDomain({ type: 'agents:changed', projectId })
          break
        }

        case 'agent:error': {
          this.flushTurn(projectId, agentId, runId)
          addMessage({
            projectId,
            agentId,
            authorType: 'system',
            kind: 'error',
            body: e.message + (e.detail ? `\n\n${e.detail.slice(0, 600)}` : ''),
          })
          setAgentStatus(agentId, e.reason === 'stalled' ? 'stalled' : 'error', e.message.slice(0, 120))
          enqueueWrite(
            'UPDATE agent_runs SET ended_at = ?, terminal_reason = ? WHERE id = ?',
            now(), e.reason, runId,
          )
          flushWrites()
          bus.emitDomain({ type: 'messages:changed', projectId })
          bus.emitDomain({ type: 'agents:changed', projectId })
          off()
          break
        }

        case 'agent:degraded':
          if (e.reason === 'compacted') {
            // The context meter is about to drop by a large amount. Without a line on the
            // timeline saying why, that looks like a bug in the meter.
            addMessage({
              projectId,
              agentId,
              authorType: 'system',
              kind: 'text',
              body: e.detail ?? 'The conversation was compacted.',
            })
            flushWrites()
            bus.emitDomain({ type: 'messages:changed', projectId })
          }
          if (e.reason === 'rate_limit') {
            bus.emitDomain({
              type: 'quota:changed',
              projectId,
              resetsAt: e.resetsAt ?? null,
              status: e.detail ?? 'limited',
            })
          }
          break
      }
    })
  }

  /** Write the accumulated turn as one message with its tool log attached. */
  private flushTurn(projectId: string, agentId: string, runId: string): void {
    const key = `${agentId}`
    const acc = this.accum.get(key)
    const tools = this.pendingTools.get(key) ?? []
    const usage = this.pendingCost.get(key) ?? null
    this.accum.delete(key)
    this.pendingTools.delete(key)
    this.pendingInputs.clear()
    this.detailBytes.delete(key)
    // Cleared BEFORE the early return: a turn that produces no message must not leave its
    // figure behind to be stapled onto the next answer.
    this.pendingCost.delete(key)

    if (!acc?.text.trim() && tools.length === 0) return

    addMessage({
      projectId,
      agentId,
      runId,
      authorType: 'agent',
      kind: 'text',
      body: acc?.text ?? '',
      providerMsgId: acc?.messageId ?? null,
      toolSummaries: tools,
      usage,
    })
    flushWrites()
    bus.emitDomain({ type: 'messages:changed', projectId })
  }

  /** Send a user turn. Starts the Pilot if it isn't running. */
  async send(
    projectId: string,
    text: string,
    model: string,
    attachments: Attachment[] = [],
  ): Promise<void> {
    /*
     * Your message appears the instant you press Enter.
     *
     * This used to `await ensure()` first, so on a cold Pilot the whole spawn — binary lookup,
     * MCP server bind, token mint, config write, process start — happened before the line you
     * had just typed was written anywhere. Ten seconds of a composer that had emptied itself
     * with nothing to show for it, which reads as the app having dropped what you said.
     *
     * Nothing downstream needs the agent id to record a *user* turn: the row carries
     * `agentId: null` by design.
     */
    addMessage({
      projectId,
      agentId: null,
      authorType: 'user',
      kind: 'text',
      body: text,
      attachments,
    })
    flushWrites()
    bus.emitDomain({ type: 'messages:changed', projectId })

    /*
     * A spawn that fails must not leave the Pilot claiming to be waking up for ever.
     *
     * `ensure` now marks the row `starting` before the slow part, which is what makes the
     * waking-up row appear at once — and that same row is what the composer, the agents rail
     * and the message stream all read. Without this, a missing binary or a refused port would
     * animate politely until the app was restarted.
     */
    let agentId: string
    try {
      agentId = await this.ensure(projectId, model)
    } catch (e) {
      const row = getPilot(projectId)
      if (row) {
        setAgentStatus(row.id, 'error', (e as Error)?.message?.slice(0, 120) ?? 'It would not start')
        flushWrites()
        bus.emitDomain({ type: 'agents:changed', projectId })
      }
      throw e
    }

    /*
     * The board, freshly, on every turn.
     *
     * `buildPilotPrompt` runs once at spawn, so the board it contains is the board as it was
     * when the session started — and a Pilot session lasts as long as the conversation. By the
     * fifth message it is reasoning about half-hour-old state, which is how it came to write
     * *"Board-Stand liegt nicht auf der Platte, aber es kann nur der ColorZilla-Entwurf sein —
     * also #4"*: a ticket number reached by elimination because the real one was not in front
     * of it.
     *
     * A few hundred tokens a turn, and it never has to guess again. It also carries the ids of
     * drafts still waiting, which is what makes `propose_ticket`'s `replaces` usable at all.
     */
    const board = liveBoardBlock({
      tickets: placeAll(listTickets(projectId)),
      routes: listRoutes(projectId),
      drafts: listOpenDrafts(projectId).map((d) => ({ id: d.id, title: d.title })),
    })

    const payload = buildPayload(`${board}

${text}`, attachments)
    if (!manager.send(agentId, payload)) {
      // The process died between ensure() and here.
      setAgentStatus(agentId, 'error', 'Not running')
      bus.emitDomain({ type: 'agents:changed', projectId })
    }
  }

  /**
   * Queue a machine-generated notice. These coalesce; user messages never do.
   *
   * **Returns whether it was actually delivered.** A notice to a Pilot that is not running
   * goes nowhere — no process, no message row, no trace. That is usually fine (the next thing
   * the user types starts one), but a caller that *dedupes* on having reported something has
   * to know, or it marks a problem told-about that nobody was ever told about. The heartbeat
   * is exactly that caller, and the failures it reports are frequently the reason the Pilot is
   * not running.
   */
  notify(projectId: string, body: string): boolean {
    const pilot = getPilot(projectId)
    if (!pilot) return false
    return manager.send(pilot.id, {
      text: `<vibepilot-notice>\n${body}\n</vibepilot-notice>`,
      channel: 'system-notice',
    })
  }

  async stop(projectId: string): Promise<void> {
    const pilot = getPilot(projectId)
    if (!pilot) return
    await manager.stop(pilot.id, 'stopped by user')
    setAgentStatus(pilot.id, 'idle', 'Stopped')
    bus.emitDomain({ type: 'agents:changed', projectId })
  }
}

/**
 * Turn a user turn plus its attachments into something the CLI can actually read.
 *
 * Two paths, because they are genuinely different:
 *
 *  - **Images** go inline as base64. The model sees the pixels; there is no substitute, and
 *    a path would just make it try to Read a binary.
 *  - **Everything else** stays on disk and the path goes in the text. The Pilot has `Read`
 *    and the attachments directory is on its `addDirs`, so it fetches what it needs. Pasting
 *    a 4MB CSV into the prompt would spend the context window the meter exists to protect.
 *
 * v1 stored attachments on the message row and sent none of them, so a file you attached
 * was visible in the transcript and invisible to the Pilot.
 */
export function buildPayload(text: string, attachments: Attachment[]): PromptPayload {
  if (attachments.length === 0) return { text, channel: 'user' }

  const images: Array<{ mediaType: string; base64: string }> = []
  const files: string[] = []

  for (const a of attachments) {
    if (a.mediaType.startsWith('image/')) {
      try {
        images.push({ mediaType: a.mediaType, base64: readFileSync(a.path).toString('base64') })
        continue
      } catch {
        // Fall through: a path the model can try to open beats silently dropping it.
      }
    }
    files.push(`- ${a.name} (${Math.round(a.bytes / 1024)} kB) — ${a.path}`)
  }

  const body = files.length
    ? `${text}\n\n<vibepilot-attachments>\nThe user attached these. Read them if they matter:\n${files.join('\n')}\n</vibepilot-attachments>`
    : text

  return { text: body, channel: 'user', images: images.length ? images : undefined }
}

export const pilot = new PilotService()
