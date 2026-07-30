import type { AgentEvent } from '@shared/events'

/**
 * Codex `exec --json` -> the frozen ten-event vocabulary.
 *
 * Every shape here was **observed**, not inferred — see `docs/architecture/01-codex-spike.md`,
 * which drives a real `codex exec` through four cases and records what came back. The
 * previous plan for this adapter was written having only ever seen `agent_message`, and two
 * of its claims turned out to be wrong:
 *
 *  - `turn.completed` DOES report usage. The plan said Codex had no token reporting; it has
 *    no *dollar* reporting, which matters not at all because the UI shows tokens.
 *  - Codex's file edits arrive as `mcp_tool_call`, not as an edit event of its own. It
 *    drives a `node_repl` MCP server to read and write.
 *
 * Pure: same input, same output, no I/O. That is what makes it testable against recorded
 * fixtures, which is the only defence against a CLI update changing the wire silently.
 */

export interface CodexWireEvent {
  type?: string
  thread_id?: string
  item?: {
    id?: string
    type?: string
    text?: string
    command?: string
    aggregated_output?: string
    exit_code?: number
    status?: string
    server?: string
    tool?: string
    arguments?: unknown
    result?: unknown
    error?: unknown
  }
  usage?: {
    input_tokens?: number
    cached_input_tokens?: number
    cache_write_input_tokens?: number
    output_tokens?: number
    reasoning_output_tokens?: number
  }
  error?: { message?: string }
}

export interface CodexTranslatorState {
  threadId: string | null
  model: string
  /** Codex spawns per turn, so "did this turn produce anything" resets each run. */
  sawTurn: boolean
  turnStartedAt: number
}

export function createCodexState(model: string): CodexTranslatorState {
  return { threadId: null, model, sawTurn: false, turnStartedAt: Date.now() }
}

export interface CodexEmitContext {
  seq: () => number
  projectId: string
  agentId: string
  runId: string
  ticketId: string | null
  parentAgentId: string | null
}

function base(ctx: CodexEmitContext) {
  return {
    seq: ctx.seq(),
    ts: Date.now(),
    projectId: ctx.projectId,
    agentId: ctx.agentId,
    runId: ctx.runId,
    ticketId: ctx.ticketId,
    parentAgentId: ctx.parentAgentId,
  }
}

/** A readable one-liner for the tool log. Codex gives us a command or an MCP tool name. */
function toolName(item: NonNullable<CodexWireEvent['item']>): string {
  if (item.type === 'command_execution') return 'Bash'
  if (item.type === 'mcp_tool_call') return `${item.server ?? 'mcp'}__${item.tool ?? 'tool'}`
  return item.type ?? 'tool'
}

function toolSummary(item: NonNullable<CodexWireEvent['item']>): string {
  if (item.type === 'command_execution') {
    const cmd = (item.command ?? '').split('\n')[0] ?? ''
    return cmd.length > 120 ? `${cmd.slice(0, 117)}...` : cmd
  }
  if (item.type === 'mcp_tool_call') {
    const args = item.arguments as { title?: string } | undefined
    return args?.title ?? `${item.server ?? 'mcp'} · ${item.tool ?? ''}`
  }
  return item.type ?? ''
}

export function translateCodex(
  v: CodexWireEvent,
  st: CodexTranslatorState,
  ctx: CodexEmitContext,
  pid: number | null,
): AgentEvent[] {
  const out: AgentEvent[] = []
  if (!v || typeof v !== 'object') return out

  switch (v.type) {
    /**
     * The resume handle. Codex has no pre-mintable session id — we learn the thread id only
     * after the process starts, which is why `preMintableSessionId` is false and why a crash
     * before this line leaves nothing to resume.
     */
    case 'thread.started': {
      st.threadId = v.thread_id ?? null
      out.push({
        ...base(ctx),
        type: 'agent:started',
        provider: 'codex',
        model: st.model,
        sessionId: st.threadId ?? '',
        cwd: '',
        tools: [],
        // Codex brings its own MCP servers; ours is attached separately and we cannot see
        // from here whether it connected. Claiming success would be a lie, so: false until
        // a vibePilot tool is actually called.
        mcpOk: false,
        pid,
      })
      break
    }

    case 'turn.started':
      st.sawTurn = true
      st.turnStartedAt = Date.now()
      out.push({ ...base(ctx), type: 'agent:thinking', phase: 'requesting' })
      break

    case 'item.started': {
      const item = v.item
      if (!item) break
      // An agent_message that has only started carries no text yet, and Codex sends no
      // deltas — so there is nothing to show until it completes. Emitting an empty text
      // event here would put a blank bubble in the chat.
      if (item.type === 'agent_message') break
      out.push({
        ...base(ctx),
        type: 'agent:tool:start',
        toolUseId: item.id ?? 'item',
        name: toolName(item),
        input: item.type === 'command_execution' ? { command: item.command } : item.arguments,
        caller: 'direct',
      })
      break
    }

    case 'item.completed': {
      const item = v.item
      if (!item) break

      if (item.type === 'agent_message') {
        // The whole message arrives at once. `final` is authoritative downstream, which is
        // exactly right here: there were never any deltas to be authoritative over.
        out.push({
          ...base(ctx),
          type: 'agent:text',
          messageId: item.id ?? null,
          blockIndex: 0,
          final: item.text ?? '',
        })
        break
      }

      const failed =
        item.error != null ||
        item.status === 'failed' ||
        (typeof item.exit_code === 'number' && item.exit_code !== 0)

      out.push({
        ...base(ctx),
        type: 'agent:tool:end',
        toolUseId: item.id ?? 'item',
        name: toolName(item),
        isError: failed,
        // Codex does not time its tools. Inventing a duration would be worse than admitting
        // we do not know.
        durationMs: null,
        summary: toolSummary(item),
        raw: item.aggregated_output ?? undefined,
      })
      break
    }

    case 'turn.completed': {
      const u = v.usage ?? {}
      const input = u.input_tokens ?? 0
      const cachedRead = u.cached_input_tokens ?? 0
      const cacheWrite = u.cache_write_input_tokens ?? 0
      // Reasoning tokens are billed as output and are invisible otherwise. Dropping them
      // would under-report a Codex teammate against a Claude one on the same board.
      const output = (u.output_tokens ?? 0) + (u.reasoning_output_tokens ?? 0)

      out.push({
        ...base(ctx),
        type: 'agent:cost',
        inputTokens: input,
        outputTokens: output,
        cacheReadTokens: cachedRead,
        cacheCreationTokens: cacheWrite,
        // Codex reports no dollar figure. We show tokens, so this costs us nothing — but
        // `estimated` is the honest label and 0 is the honest number.
        costUsd: 0,
        costSource: 'estimated',
        model: st.model,
        /*
         * How much context this turn occupied — and only that.
         *
         * `input_tokens` is everything that went up: the system prompt, the tool definitions,
         * and on a resumed thread the whole conversation so far, because Codex re-sends it
         * every turn. That total *is* the context in use at the end of the turn, measured
         * rather than modelled, and it grows visibly as a thread gets long — which is the one
         * thing worth watching on a provider that re-sends its instructions each time.
         *
         * `contextMax` stays absent, and that is a finding rather than an omission. It is not
         * in `model/list`, and `config/read` returns `model_context_window: null` because that
         * key is a *user override*, not the model's real size. The CLI knows the number and
         * does not expose it over `codex exec`.
         *
         * So the numerator ships and the denominator does not. A percentage here would have to
         * be built on a hardcoded window per model — the precise thing that goes stale silently
         * and the reason the model list is discovered rather than written down. A meter that
         * reads 40% against an invented maximum is worse than one that says 55k and stops:
         * the first is trusted and wrong, the second is trusted and right.
         */
        contextUsed: input > 0 ? input : undefined,
      })

      out.push({
        ...base(ctx),
        type: 'agent:done',
        terminal: 'completed',
        stopReason: null,
        numTurns: 1,
        durationMs: Date.now() - st.turnStartedAt,
      })
      break
    }

    case 'error':
      out.push({
        ...base(ctx),
        type: 'agent:error',
        reason: 'cli_error',
        message: v.error?.message ?? 'Codex reported an error.',
        recoverable: true,
      })
      break
  }

  return out
}
