import type { AgentEvent } from '@shared/events'
import { summariseTool } from '../../engine/status'
import type { WireMessage } from './wire'

/**
 * Pure translator: one wire message in, zero or more vibePilot events out.
 *
 * Deliberately pure and side-effect free so it can be tested against a corpus of recorded
 * sessions. The CLI self-updates; when its wire format shifts, this is the one file that
 * changes and the fixtures are what tell you it broke.
 */

export interface TranslatorContext {
  seq: () => number
  projectId: string
  agentId: string
  runId: string
  ticketId: string | null
  parentAgentId: string | null
  provider: 'claude'
}

/** Mutable per-run parse state. Kept outside the function so the function stays pure-ish. */
export interface TranslatorState {
  started: boolean
  model: string
  sessionId: string
  /** Accumulated `input_json_delta` per content-block index. Never JSON.parse until done. */
  toolInputs: Map<number, { toolUseId: string; name: string; partial: string }>
  /** Index -> tool_use_id, for matching content_block_start to the assistant message. */
  openBlocks: Map<number, string>
  /** tool_use_id -> tool name, so tool:end can report something the UI can render. */
  toolNames: Map<string, string>
  lastMessageId: string | null
  pendingSummary: string | null
  mcpOk: boolean
  contextMax: number | null
  /**
   * Prompt size of the most recent MAIN-THREAD request — the real context occupancy.
   *
   * Not derivable from `result.usage`, which sums every API round-trip in the turn. An
   * agentic turn makes one round-trip per tool cycle and re-sends the whole conversation
   * each time, almost all of it as a cache read, so that sum grows without bound and is
   * not a measurement of anything. Measured against a live session: true occupancy
   * 138,277 tokens; the old formula produced 3,808,965.
   */
  lastPromptTokens: number | null
}

export function createTranslatorState(sessionId: string, model: string): TranslatorState {
  return {
    started: false,
    model,
    sessionId,
    toolInputs: new Map(),
    openBlocks: new Map(),
    toolNames: new Map(),
    lastMessageId: null,
    pendingSummary: null,
    mcpOk: false,
    contextMax: null,
    lastPromptTokens: null,
  }
}

/**
 * The context window of the model this agent is actually running.
 *
 * `modelUsage` keys are resolved ids ("claude-opus-5", sometimes with a "[1m]" suffix) while
 * `st.model` may be an alias ("opus") — so an exact lookup is not enough. Match exactly,
 * then by substring, and only then fall back to the largest window present. Largest rather
 * than first: an over-large window under-reports the meter, which is the safe direction,
 * whereas a too-small one shows a false 100% and invites people to restart a healthy agent.
 */
/**
 * Caps for tool detail, applied HERE — the one choke point upstream of the bus, the IPC
 * batch and SQLite at once. Capping at persistence would still have shipped a whole file
 * body across IPC first.
 */
const CAP_INPUT = 1024
const CAP_OUTPUT = 2048
/** How the surviving budget is split. Head gets more; the tail carries the error message. */
const HEAD_SHARE = 0.6

/**
 * Head AND tail, never head-only.
 *
 * People expand a step to find out why something failed, and a failure message lives at the
 * end of the output. Head-only truncation is precisely useless for the one case it exists
 * to serve.
 *
 * The head and tail sizes used to be fixed constants — 1200 and 800 — which meant a "capped"
 * value came out at ~2050 characters against a CAP_INPUT of 1024. The clamp made things
 * bigger. Deriving both from the cap is what makes the name true.
 */
function clamp(s: string, cap: number): { text: string; truncated: boolean } {
  if (s.length <= cap) return { text: s, truncated: false }
  const marker = '\n… 000,000 characters elided …\n'
  const budget = Math.max(0, cap - marker.length)
  const head = Math.floor(budget * HEAD_SHARE)
  const tail = budget - head
  const elided = s.length - head - tail
  return {
    text: `${s.slice(0, head)}\n… ${elided.toLocaleString()} characters elided …\n${s.slice(s.length - tail)}`,
    truncated: true,
  }
}

/** A tool result is a string, or an array of content blocks, or something unforeseen. */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        const block = b as Record<string, unknown>
        return block?.['type'] === 'text' && typeof block['text'] === 'string' ? block['text'] : ''
      })
      .filter(Boolean)
      .join('\n')
  }
  try {
    return JSON.stringify(content ?? '', null, 2)
  } catch {
    return ''
  }
}

export function contextWindowFor(
  modelUsage: Record<string, { contextWindow?: number }>,
  model: string,
): number | null {
  const entries = Object.entries(modelUsage).filter(([, v]) => typeof v?.contextWindow === 'number')
  if (entries.length === 0) return null

  const exact = entries.find(([k]) => k === model)
  if (exact) return exact[1].contextWindow!

  const base = model.replace(/\[.*\]$/, '').toLowerCase()
  const partial = entries.find(([k]) => {
    const kb = k.replace(/\[.*\]$/, '').toLowerCase()
    return kb === base || kb.includes(base) || base.includes(kb)
  })
  if (partial) return partial[1].contextWindow!

  return Math.max(...entries.map(([, v]) => v.contextWindow!))
}

export function translate(
  msg: WireMessage,
  st: TranslatorState,
  ctx: TranslatorContext,
  pid: number | null = null,
): AgentEvent[] {
  const out: AgentEvent[] = []
  const base = () => ({
    seq: ctx.seq(),
    ts: Date.now(),
    projectId: ctx.projectId,
    agentId: ctx.agentId,
    runId: ctx.runId,
    ticketId: ctx.ticketId,
    parentAgentId: ctx.parentAgentId,
  })

  const m = msg as Record<string, unknown>
  const subagentOf = (m['parent_tool_use_id'] as string | null | undefined) ?? null

  switch (m['type']) {
    // ── system ────────────────────────────────────────────────────────────────
    case 'system': {
      const sub = m['subtype']

      if (sub === 'init') {
        const servers = (m['mcp_servers'] as Array<{ name: string; status: string }>) ?? []
        const mcpOk = servers.some((s) => s.name === 'vibepilot' && s.status === 'connected')
        if (typeof m['session_id'] === 'string') st.sessionId = m['session_id']
        if (typeof m['model'] === 'string') st.model = m['model']

        /*
         * A new turn starts here, so the context high-water mark starts again.
         *
         * `lastPromptTokens` kept a max for the life of the PROCESS, which is a per-process
         * peak wearing a per-turn comment — my bug. After a compaction the real context drops
         * from, say, 187k to 20k and the meter stayed at 187k for as long as the agent lived,
         * so every threshold built on it fired permanently and the one number the meter exists
         * to show was the one number it could not show.
         */
        st.lastPromptTokens = null

        if (!st.started) {
          // system/init fires once per TURN, not once per process. Only the first is
          // a lifecycle event; later ones are just a chance to re-check MCP health.
          st.started = true
          st.mcpOk = mcpOk
          out.push({
            ...base(),
            type: 'agent:started',
            provider: 'claude',
            model: st.model,
            sessionId: st.sessionId,
            cwd: (m['cwd'] as string) ?? '',
            tools: (m['tools'] as string[]) ?? [],
            mcpOk,
            pid,
          })
        } else if (st.mcpOk && !mcpOk) {
          st.mcpOk = false
          out.push({
            ...base(),
            type: 'agent:degraded',
            reason: 'mcp_unavailable',
            detail: 'The vibePilot bridge disconnected — this agent can no longer update tickets.',
          })
        }
        return out
      }

      if (sub === 'status' && m['status'] === 'requesting') {
        out.push({ ...base(), type: 'agent:thinking', phase: 'requesting' })
        return out
      }

      /*
       * Compaction takes 30–300 seconds during which nothing else is emitted. Without this the
       * agent looks hung, at exactly the moment you are most likely to kill it — which throws
       * away the summary it was in the middle of writing.
       */
      if (sub === 'status' && m['status'] === 'compacting') {
        out.push({ ...base(), type: 'agent:thinking', phase: 'compacting' })
        return out
      }

      /*
       * The conversation was summarised.
       *
       * `compact_metadata` carries `trigger` and `pre_tokens`, and `post_tokens` once the new
       * context is known. Taking `post_tokens` as the live figure is the whole point: it is the
       * only moment the context legitimately goes DOWN, and the max-based accumulator would
       * otherwise ignore it.
       */
      if (sub === 'compact_boundary') {
        const meta = (m['compact_metadata'] ?? {}) as Record<string, unknown>
        const pre = Number(meta['pre_tokens'] ?? 0)
        const post = Number(meta['post_tokens'] ?? 0)
        const trigger = typeof meta['trigger'] === 'string' ? meta['trigger'] : 'auto'

        st.lastPromptTokens = post > 0 ? post : null

        const size = (n: number): string =>
          n >= 1000 ? `${Math.round(n / 1000)}k` : String(Math.round(n))
        const movement =
          pre > 0 && post > 0
            ? `${size(pre)} → ${size(post)} tokens`
            : pre > 0
              ? `from ${size(pre)} tokens`
              : 'the conversation was summarised'

        out.push({
          ...base(),
          type: 'agent:degraded',
          reason: 'compacted',
          detail: `Context compacted (${trigger}): ${movement}. Earlier detail is now a summary.`,
        })
        return out
      }

      if (sub === 'post_turn_summary') {
        // Attach to the upcoming agent:done rather than emitting on its own.
        const detail = m['status_detail']
        if (typeof detail === 'string' && detail.trim()) st.pendingSummary = detail.trim()
        return out
      }
      return out
    }

    // ── streaming deltas ──────────────────────────────────────────────────────
    case 'stream_event': {
      const ev = (m['event'] ?? {}) as Record<string, unknown>
      const index = (ev['index'] as number) ?? 0
      const etype = ev['type'] as string

      if (etype === 'message_start') {
        const msgObj = ev['message'] as { id?: string } | undefined
        st.lastMessageId = msgObj?.id ?? null
        return out
      }

      if (etype === 'content_block_start') {
        const cb = (ev['content_block'] ?? {}) as Record<string, unknown>
        if (cb['type'] === 'tool_use') {
          const toolUseId = (cb['id'] as string) ?? `blk_${index}`
          const name = (cb['name'] as string) ?? 'tool'
          st.toolInputs.set(index, { toolUseId, name, partial: '' })
          st.openBlocks.set(index, toolUseId)
          st.toolNames.set(toolUseId, name)
          out.push({
            ...base(),
            subagentOf,
            type: 'agent:tool:start',
            toolUseId,
            name,
            caller:
              ((cb['caller'] as { type?: string } | undefined)?.type ?? 'direct') === 'direct'
                ? 'direct'
                : 'subagent',
          })
        } else if (cb['type'] === 'thinking') {
          out.push({ ...base(), subagentOf, type: 'agent:thinking', phase: 'reasoning', blockIndex: index })
        }
        return out
      }

      if (etype === 'content_block_delta') {
        const d = (ev['delta'] ?? {}) as Record<string, unknown>
        if (d['type'] === 'text_delta' && typeof d['text'] === 'string') {
          out.push({
            ...base(),
            subagentOf,
            type: 'agent:text',
            messageId: st.lastMessageId,
            blockIndex: index,
            delta: d['text'],
          })
        } else if (d['type'] === 'thinking_delta' && typeof d['thinking'] === 'string') {
          out.push({
            ...base(),
            subagentOf,
            type: 'agent:thinking',
            phase: 'reasoning',
            blockIndex: index,
            delta: d['thinking'],
          })
        } else if (d['type'] === 'input_json_delta' && typeof d['partial_json'] === 'string') {
          // Accumulate only. The fragments are deliberately not valid JSON on their own,
          // so parsing here would throw constantly.
          const acc = st.toolInputs.get(index)
          if (acc) acc.partial += d['partial_json']
        }
        return out
      }
      return out
    }

    // ── the authoritative assembled message ───────────────────────────────────
    case 'assistant': {
      // Arrives BEFORE content_block_stop and wins over accumulated deltas. This is
      // where text gets persisted — deltas are transient display only.
      const message = m['message'] as
        | { content?: unknown[]; usage?: Record<string, number> }
        | undefined
      const content = (message?.content ?? []) as Array<Record<string, unknown>>

      // The prompt size of THIS request is the live context. Sub-agent requests run their
      // own separate context, so they must not overwrite the main thread's figure.
      if (!subagentOf && message?.usage) {
        const u = message.usage
        const prompt =
          (u['input_tokens'] ?? 0) +
          (u['cache_read_input_tokens'] ?? 0) +
          (u['cache_creation_input_tokens'] ?? 0)
        // The last request of a turn is the largest; keep the max so an out-of-order or
        // partial message cannot make the meter jump backwards mid-turn.
        if (prompt > 0) st.lastPromptTokens = Math.max(st.lastPromptTokens ?? 0, prompt)
      }

      let blockIndex = 0
      for (const block of content) {
        if (block['type'] === 'text' && typeof block['text'] === 'string') {
          out.push({
            ...base(),
            subagentOf,
            type: 'agent:text',
            messageId: st.lastMessageId,
            blockIndex: blockIndex,
            final: block['text'],
          })
        } else if (block['type'] === 'tool_use') {
          const toolUseId = (block['id'] as string) ?? ''
          const toolName = (block['name'] as string) ?? 'tool'
          st.toolNames.set(toolUseId, toolName)
          out.push({
            ...base(),
            subagentOf,
            type: 'agent:tool:start',
            toolUseId,
            name: toolName,
            // Stringified and capped rather than passed live: a `Write` input is the entire
            // file body, and the coalescer's byte budget does not count object payloads.
            input: clamp(toolResultText(block['input']), CAP_INPUT).text,
            caller: subagentOf ? 'subagent' : 'direct',
          })
        }
        blockIndex++
      }
      st.toolInputs.clear()
      return out
    }

    // ── tool results ──────────────────────────────────────────────────────────
    case 'user': {
      const content = ((m['message'] as { content?: unknown[] } | undefined)?.content ??
        []) as Array<Record<string, unknown>>
      const meta = (m['tool_use_result'] ?? {}) as Record<string, unknown>
      for (const block of content) {
        if (block['type'] !== 'tool_result') continue
        const toolUseId = (block['tool_use_id'] as string) ?? ''
        const isError = block['is_error'] === true
        const name = nameForToolUse(st, toolUseId)
        // `raw` has been declared on AgentToolEnd since v1 and was never populated, so
        // "expand a step to see what it did" had nothing to show. This is the output.
        const body = clamp(toolResultText(block['content']), CAP_OUTPUT)
        out.push({
          ...base(),
          subagentOf,
          type: 'agent:tool:end',
          toolUseId,
          name,
          isError,
          // The CLI measured this; recomputing from our own clock would include IPC lag.
          durationMs: typeof meta['durationMs'] === 'number' ? meta['durationMs'] : null,
          summary: summariseTool(name, meta, isError),
          raw: body.text || undefined,
          truncated: body.truncated,
        })
      }
      return out
    }

    // ── quota ─────────────────────────────────────────────────────────────────
    case 'rate_limit_event': {
      const info = (m['rate_limit_info'] ?? {}) as Record<string, unknown>
      if (info['status'] && info['status'] !== 'allowed') {
        out.push({
          ...base(),
          type: 'agent:degraded',
          reason: 'rate_limit',
          detail: `${String(info['rateLimitType'] ?? 'rate')} limit — ${String(info['status'])}`,
          resetsAt: typeof info['resetsAt'] === 'number' ? info['resetsAt'] * 1000 : null,
        })
      }
      return out
    }

    // ── end of turn ───────────────────────────────────────────────────────────
    case 'result': {
      const usage = (m['usage'] ?? {}) as Record<string, number>
      const modelUsage = (m['modelUsage'] ?? {}) as Record<string, { contextWindow?: number }>

      /**
       * `modelUsage` is keyed per model, and a turn can touch more than one — Claude Code
       * runs its own background Haiku calls, and a `Task` sub-agent may be on a different
       * tier entirely. Taking `Object.values(...)[0]` picked whichever key happened to come
       * first, so an Opus 5 agent (1M window) intermittently reported Haiku's 200k. That is
       * the "/200k" in the bug report, and why the figure flipped between turns.
       */
      const ctxMax = contextWindowFor(modelUsage, st.model) ?? st.contextMax
      if (ctxMax) st.contextMax = ctxMax

      // `/clear` starts a new session mid-process. Every result carries the current id, so
      // reading it here is how the stored resume handle stays pointed at something real.
      if (typeof m['session_id'] === 'string' && m['session_id']) st.sessionId = m['session_id']

      /**
       * Top-level `usage` is all zeros on some terminations — a budget stop most reliably,
       * but it has also been observed on a probe that genuinely consumed 6,903 output tokens
       * and reported `output_tokens: 0`. `modelUsage` carries the real numbers in those
       * cases, so fall back to summing it rather than recording a turn that cost nothing.
       */
      const fromModelUsage = (): Record<string, number> => {
        const t = { input_tokens: 0, output_tokens: 0, cache_read: 0, cache_create: 0 }
        for (const v of Object.values(modelUsage) as Array<Record<string, unknown>>) {
          t.input_tokens += Number(v['inputTokens'] ?? 0)
          t.output_tokens += Number(v['outputTokens'] ?? 0)
          t.cache_read += Number(v['cacheReadInputTokens'] ?? 0)
          t.cache_create += Number(v['cacheCreationInputTokens'] ?? 0)
        }
        return t
      }
      const rawTotal =
        (usage['input_tokens'] ?? 0) +
        (usage['output_tokens'] ?? 0) +
        (usage['cache_read_input_tokens'] ?? 0) +
        (usage['cache_creation_input_tokens'] ?? 0)
      const u = rawTotal > 0 ? usage : fromModelUsage()

      const inputTokens = u['input_tokens'] ?? 0
      const cacheRead = u['cache_read_input_tokens'] ?? u['cache_read'] ?? 0
      const cacheCreate = u['cache_creation_input_tokens'] ?? u['cache_create'] ?? 0

      out.push({
        ...base(),
        type: 'agent:cost',
        inputTokens,
        outputTokens: u['output_tokens'] ?? 0,
        cacheReadTokens: cacheRead,
        cacheCreationTokens: cacheCreate,
        costUsd: typeof m['total_cost_usd'] === 'number' ? m['total_cost_usd'] : 0,
        costSource: 'provider',
        model: st.model,
        // The live context, from the last request — NOT the turn's token total. Those
        // are different numbers and only one of them belongs in a meter.
        contextUsed: st.lastPromptTokens ?? undefined,
        contextMax: st.contextMax ?? undefined,
      })

      const denials = m['permission_denials']
      if (Array.isArray(denials) && denials.length > 0) {
        out.push({
          ...base(),
          type: 'agent:degraded',
          reason: 'permission_denied',
          detail: `${denials.length} tool call${denials.length === 1 ? '' : 's'} were blocked by policy.`,
        })
      }

      /**
       * Budget termination is a STOP, not a failure — test it before the generic error branch.
       *
       * The CLI sets `is_error: true` on a budget result, so the generic branch swallowed it
       * first. And that result carries neither a `result` string nor an `api_error_status`, so
       * the message degraded to the literal "The model call failed." — the word *budget* never
       * appeared, and it propagated to the board and to the Pilot as an unexplained failure.
       */
      if (m['terminal_reason'] === 'budget_exhausted') {
        const errs = m['errors']
        out.push({
          ...base(),
          type: 'agent:done',
          terminal: 'budget',
          stopReason: 'budget_exhausted',
          numTurns: (m['num_turns'] as number) ?? 0,
          durationMs: (m['duration_ms'] as number) ?? 0,
          summary: st.pendingSummary,
          sessionId: st.sessionId,
          resultText:
            Array.isArray(errs) && typeof errs[0] === 'string'
              ? errs[0]
              : 'Reached the spend limit for this assignment.',
        })
      } else if (m['is_error'] === true) {
        out.push({
          ...base(),
          type: 'agent:error',
          reason: 'api_error',
          message:
            typeof m['result'] === 'string' && m['result']
              ? m['result']
              : `The model call failed${m['api_error_status'] ? ` (HTTP ${String(m['api_error_status'])})` : ''}.`,
          recoverable: true,
        })
      } else {
        out.push({
          ...base(),
          type: 'agent:done',
          terminal: 'completed',
          stopReason: (m['stop_reason'] as string | null) ?? null,
          numTurns: (m['num_turns'] as number) ?? 0,
          durationMs: (m['duration_ms'] as number) ?? 0,
          summary: st.pendingSummary,
          resultText: typeof m['result'] === 'string' ? m['result'] : null,
          sessionId: st.sessionId,
        })
      }
      st.pendingSummary = null
      return out
    }

    default:
      return out
  }
}

function nameForToolUse(st: TranslatorState, toolUseId: string): string {
  return st.toolNames.get(toolUseId) ?? 'tool'
}
