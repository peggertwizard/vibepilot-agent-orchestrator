import { describe, expect, it } from 'vitest'
import type { AgentEvent } from '../src/shared/events'
import {
  contextWindowFor,
  createTranslatorState,
  translate,
  type TranslatorContext,
} from '../src/main/providers/claude/translate'

/**
 * One API round-trip whose prompt was `prompt` tokens. The split across input vs cache is
 * irrelevant to occupancy — what occupies the window is the total.
 */
function assistantWithUsage(prompt: number): Record<string, unknown> {
  return {
    type: 'assistant',
    message: {
      id: `msg_${prompt}`,
      content: [],
      usage: { input_tokens: 10, cache_read_input_tokens: prompt - 10, output_tokens: 5 },
    },
  }
}

/**
 * The translator is the one file guaranteed to break when Claude Code updates itself.
 * These fixtures are real wire shapes captured from 2.1.220 — when the CLI changes, this
 * is what turns a mysterious blank UI into a failing test.
 */

let seq = 0
const ctx: TranslatorContext = {
  seq: () => ++seq,
  projectId: 'p1',
  agentId: 'a1',
  runId: 'r1',
  ticketId: null,
  parentAgentId: null,
  provider: 'claude',
}

const run = (msgs: unknown[], sessionId = 's1'): AgentEvent[] => {
  const st = createTranslatorState(sessionId, 'claude-sonnet-4-6')
  return msgs.flatMap((m) => translate(m as never, st, ctx, 1234))
}

const types = (events: AgentEvent[]): string[] => events.map((e) => e.type)

describe('system/init', () => {
  it('emits agent:started once, not per turn', () => {
    const init = {
      type: 'system',
      subtype: 'init',
      cwd: 'C:\\repo',
      session_id: 'sess-abc',
      tools: ['Read', 'Grep'],
      mcp_servers: [{ name: 'vibepilot', status: 'connected' }],
      model: 'claude-sonnet-4-6',
    }
    // system/init fires once per TURN — a second one must not look like a second agent.
    const events = run([init, init])
    expect(types(events)).toEqual(['agent:started'])
    const started = events[0]!
    expect(started.type).toBe('agent:started')
    if (started.type === 'agent:started') {
      expect(started.mcpOk).toBe(true)
      expect(started.sessionId).toBe('sess-abc')
      expect(started.pid).toBe(1234)
    }
  })

  it('flags a failed MCP bridge', () => {
    const events = run([
      {
        type: 'system',
        subtype: 'init',
        mcp_servers: [{ name: 'vibepilot', status: 'failed' }],
      },
    ])
    const started = events[0]
    if (started?.type === 'agent:started') expect(started.mcpOk).toBe(false)
  })

  it('reports degradation when the bridge drops mid-session', () => {
    const ok = { type: 'system', subtype: 'init', mcp_servers: [{ name: 'vibepilot', status: 'connected' }] }
    const bad = { type: 'system', subtype: 'init', mcp_servers: [{ name: 'vibepilot', status: 'failed' }] }
    const events = run([ok, bad])
    expect(types(events)).toEqual(['agent:started', 'agent:degraded'])
  })
})

describe('streaming text', () => {
  it('emits deltas then an authoritative final', () => {
    const events = run([
      { type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_1' } } },
      {
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } },
      },
      {
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo' } },
      },
      { type: 'assistant', message: { id: 'msg_1', content: [{ type: 'text', text: 'Hello' }] } },
    ])
    expect(types(events)).toEqual(['agent:text', 'agent:text', 'agent:text'])
    const final = events[2]
    if (final?.type === 'agent:text') {
      // The assembled message wins over accumulated deltas — this is what gets persisted.
      expect(final.final).toBe('Hello')
      expect(final.delta).toBeUndefined()
    }
  })

  it('never parses partial tool JSON', () => {
    // `partial_json` fragments are deliberately invalid on their own; parsing them throws.
    const events = run([
      {
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'toolu_1', name: 'Grep', caller: { type: 'direct' } },
        },
      },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"pattern": "' },
        },
      },
    ])
    expect(types(events)).toEqual(['agent:tool:start'])
  })
})

describe('tool results', () => {
  it('pairs tool:end with the name from tool:start and uses CLI timing', () => {
    const events = run([
      {
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'toolu_9', name: 'Grep', caller: { type: 'direct' } },
        },
      },
      {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_9', is_error: false }] },
        tool_use_result: { durationMs: 37, totalMatches: 3 },
      },
    ])
    const end = events.find((e) => e.type === 'agent:tool:end')
    expect(end).toBeDefined()
    if (end?.type === 'agent:tool:end') {
      expect(end.name).toBe('Grep')
      expect(end.durationMs).toBe(37)
      expect(end.summary).toBe('3 matches')
      expect(end.isError).toBe(false)
    }
  })

  it('marks a failed tool', () => {
    const events = run([
      {
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 't1', name: 'Read' },
        },
      },
      {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true }] },
      },
    ])
    const end = events.find((e) => e.type === 'agent:tool:end')
    if (end?.type === 'agent:tool:end') {
      expect(end.isError).toBe(true)
      expect(end.summary).toBe('read failed')
    }
  })
})

describe('subagents', () => {
  it('tags Task subagent output without creating a new agent', () => {
    const events = run([
      {
        type: 'stream_event',
        parent_tool_use_id: 'toolu_parent',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
      },
    ])
    expect(events[0]?.subagentOf).toBe('toolu_parent')
    expect(events[0]?.agentId).toBe('a1')
  })
})

describe('result', () => {
  it('emits cost then done, with provider cost and context usage', () => {
    const events = run([
      {
        type: 'result',
        subtype: 'success',
        is_error: false,
        duration_ms: 12644,
        num_turns: 3,
        stop_reason: 'end_turn',
        total_cost_usd: 0.0485915,
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 4000,
          cache_creation_input_tokens: 900,
        },
        modelUsage: { 'claude-sonnet-5': { contextWindow: 1000000 } },
        result: 'all done',
      },
    ])
    expect(types(events)).toEqual(['agent:cost', 'agent:done'])
    const cost = events[0]
    if (cost?.type === 'agent:cost') {
      expect(cost.costUsd).toBeCloseTo(0.0485915)
      expect(cost.costSource).toBe('provider')
      // The turn's token totals still come from result.usage — those ARE cumulative and
      // that is correct for a spend figure.
      expect(cost.inputTokens).toBe(100)
      expect(cost.cacheReadTokens).toBe(4000)
      expect(cost.contextMax).toBe(1000000)
    }
  })

  /**
   * The context meter reported "318k/200k" — over its own maximum. Two separate bugs, both
   * proven against a live session before being fixed here.
   */
  describe('context occupancy', () => {
    it('measures the live context from the last request, NOT the turn total', () => {
      const events = run([
        // Three API round-trips in one agentic turn. Each re-sends the whole conversation,
        // almost all of it as a cache read, so the prompt grows — but the CONTEXT is only
        // ever as big as the last request.
        assistantWithUsage(10_000),
        assistantWithUsage(30_000),
        assistantWithUsage(50_000),
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          duration_ms: 1,
          num_turns: 3,
          total_cost_usd: 1,
          // What the CLI aggregates over the whole turn: 90k. Summing this was the bug —
          // it grows with tool-call count and has no upper bound at all.
          usage: {
            input_tokens: 30,
            output_tokens: 100,
            cache_read_input_tokens: 80_000,
            cache_creation_input_tokens: 9_970,
          },
          modelUsage: { 'claude-opus-5': { contextWindow: 1_000_000 } },
          result: 'done',
        },
      ])
      const cost = events.find((e) => e.type === 'agent:cost')
      if (cost?.type !== 'agent:cost') throw new Error('no cost event')
      expect(cost.contextUsed, 'the last request, not the sum of all three').toBe(50_000)
      expect(cost.contextUsed).toBeLessThan(cost.contextMax!)
    })

    it("a sub-agent's context never overwrites the main thread's", () => {
      const events = run([
        assistantWithUsage(50_000),
        // A Task sub-agent runs its own separate context. Counting it here is how the
        // meter would report a number the main thread never had.
        { ...assistantWithUsage(9_000), parent_tool_use_id: 'toolu_parent' },
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          duration_ms: 1,
          num_turns: 1,
          total_cost_usd: 1,
          usage: { input_tokens: 1, output_tokens: 1 },
          modelUsage: { 'claude-opus-5': { contextWindow: 1_000_000 } },
          result: 'done',
        },
      ])
      const cost = events.find((e) => e.type === 'agent:cost')
      if (cost?.type !== 'agent:cost') throw new Error('no cost event')
      expect(cost.contextUsed).toBe(50_000)
    })

    it('takes the window of the model the agent is on, not whichever key is first', () => {
      // This is the "/200k": Claude Code makes its own background Haiku calls, and Haiku is
      // the only current 200k model. Picking entry [0] handed an Opus 5 agent Haiku's window.
      const events = run([
        assistantWithUsage(300_000),
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          duration_ms: 1,
          num_turns: 1,
          total_cost_usd: 1,
          usage: { input_tokens: 1, output_tokens: 1 },
          modelUsage: {
            'claude-haiku-4-5-20251001': { contextWindow: 200_000 },
            'claude-opus-5': { contextWindow: 1_000_000 },
          },
          result: 'done',
        },
      ])
      const cost = events.find((e) => e.type === 'agent:cost')
      if (cost?.type !== 'agent:cost') throw new Error('no cost event')
      expect(cost.contextMax, 'the agent is on opus, not haiku').toBe(1_000_000)
      // And so the meter is no longer over 100%.
      expect(cost.contextUsed! / cost.contextMax!).toBeLessThan(1)
    })
  })

  describe('contextWindowFor', () => {
    const usage = {
      'claude-haiku-4-5-20251001': { contextWindow: 200_000 },
      'claude-opus-5': { contextWindow: 1_000_000 },
    }

    it('matches an alias against a resolved id', () => {
      expect(contextWindowFor(usage, 'opus')).toBe(1_000_000)
      expect(contextWindowFor(usage, 'haiku')).toBe(200_000)
    })

    it('matches an exact id, suffix and all', () => {
      expect(contextWindowFor({ 'claude-opus-5[1m]': { contextWindow: 1_000_000 } }, 'claude-opus-5[1m]')).toBe(1_000_000)
      expect(contextWindowFor(usage, 'claude-opus-5')).toBe(1_000_000)
    })

    it('falls back to the LARGEST window, never the first', () => {
      // An over-large window under-reports, which is the safe direction. A too-small one
      // shows a false 100% and invites restarting a perfectly healthy agent.
      expect(contextWindowFor(usage, 'something-unrecognised')).toBe(1_000_000)
    })

    it('returns null when there is nothing to go on', () => {
      expect(contextWindowFor({}, 'opus')).toBeNull()
      expect(contextWindowFor({ 'claude-opus-5': {} }, 'opus')).toBeNull()
    })
  })

  it('turns an API error into agent:error, not agent:done', () => {
    const events = run([
      { type: 'result', is_error: true, api_error_status: 529, result: 'overloaded', usage: {} },
    ])
    expect(types(events)).toEqual(['agent:cost', 'agent:error'])
  })

  it('attaches the model-authored summary to done', () => {
    const events = run([
      { type: 'system', subtype: 'post_turn_summary', status_detail: 'Reviewed the cart module' },
      { type: 'result', subtype: 'success', usage: {}, num_turns: 1 },
    ])
    const done = events.find((e) => e.type === 'agent:done')
    if (done?.type === 'agent:done') expect(done.summary).toBe('Reviewed the cart module')
  })
})

describe('rate limits', () => {
  it('ignores an allowed status and reports a real one', () => {
    expect(
      run([{ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }]),
    ).toHaveLength(0)

    const events = run([
      {
        type: 'rate_limit_event',
        rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: 1785247800 },
      },
    ])
    const d = events[0]
    if (d?.type === 'agent:degraded') {
      expect(d.reason).toBe('rate_limit')
      // resetsAt arrives in seconds; the UI works in ms.
      expect(d.resetsAt).toBe(1785247800 * 1000)
    }
  })
})

describe('robustness', () => {
  it('ignores unknown message types rather than throwing', () => {
    expect(run([{ type: 'some_future_thing', payload: 1 }])).toHaveLength(0)
    expect(run([{ type: 'stream_event', event: { type: 'message_stop' } }])).toHaveLength(0)
  })

  it('survives missing fields', () => {
    expect(() => run([{ type: 'assistant' }, { type: 'user' }, { type: 'result' }])).not.toThrow()
  })
})

/**
 * A budget stop, captured verbatim from the shipped CLI (2.1.220) by running:
 *
 *   claude -p "Say the single word: hi" --max-budget-usd 0.0001 --output-format json
 *
 * Two things about it matter and are easy to get wrong. `is_error` is true, so a generic
 * error branch swallows it first. And it carries neither a `result` string nor an
 * `api_error_status`, so the fallback message degraded to "The model call failed." — the word
 * budget never appeared, and that is what reached the board and the Pilot.
 *
 * The top-level `usage` block is also all zeros while `modelUsage` carries the real numbers.
 */
const BUDGET_RESULT = {
  type: 'result',
  subtype: 'error_max_budget_usd',
  is_error: true,
  terminal_reason: 'budget_exhausted',
  errors: ['Reached maximum budget ($0.0001)'],
  num_turns: 1,
  duration_ms: 4212,
  total_cost_usd: 0.095582,
  usage: {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  },
  modelUsage: {
    'claude-opus-5[1m]': {
      inputTokens: 2,
      outputTokens: 4,
      cacheReadInputTokens: 24004,
      cacheCreationInputTokens: 8347,
      costUSD: 0.095582,
      contextWindow: 1_000_000,
    },
  },
} as const

describe('running out of budget', () => {
  it('is a stop, not a failure', () => {
    const st = createTranslatorState('s-budget', 'claude-opus-5[1m]')
    const out = translate(BUDGET_RESULT, st, ctx)

    const done = out.find((e: AgentEvent) => e.type === 'agent:done')
    expect(done, 'a budget stop must end the run cleanly, not error').toBeDefined()
    if (done?.type === 'agent:done') {
      expect(done.terminal).toBe('budget')
      expect(done.resultText).toContain('budget')
    }

    // The old behaviour: swallowed by the generic is_error branch.
    expect(out.find((e: AgentEvent) => e.type === 'agent:error')).toBeUndefined()
  })

  it('recovers the real token counts from modelUsage when usage is zeroed', () => {
    const st = createTranslatorState('s-budget', 'claude-opus-5[1m]')
    const cost = translate(BUDGET_RESULT, st, ctx).find(
      (e: AgentEvent) => e.type === 'agent:cost',
    )
    expect(cost).toBeDefined()
    if (cost?.type === 'agent:cost') {
      // Recording a turn as free because the top-level block was zeroed is how spend
      // disappears from the ledger.
      expect(cost.outputTokens).toBe(4)
      expect(cost.cacheReadTokens).toBe(24004)
      expect(cost.cacheCreationTokens).toBe(8347)
      expect(cost.costUsd).toBeCloseTo(0.095582, 6)
    }
  })

  it('leaves a normal result alone', () => {
    const st = createTranslatorState('s-ok', 'claude-sonnet-5')
    const out = translate(
      {
        type: 'result',
        is_error: false,
        result: 'done',
        num_turns: 3,
        duration_ms: 900,
        total_cost_usd: 0.5,
        usage: { input_tokens: 7, output_tokens: 11 },
        modelUsage: { 'claude-sonnet-5': { contextWindow: 200_000 } },
      },
      st,
      ctx,
    )
    const done = out.find((e: AgentEvent) => e.type === 'agent:done')
    if (done?.type === 'agent:done') expect(done.terminal).toBe('completed')
    const cost = out.find((e: AgentEvent) => e.type === 'agent:cost')
    if (cost?.type === 'agent:cost') expect(cost.inputTokens).toBe(7)
  })
})

/**
 * `clamp` did not clamp.
 *
 * HEAD (1200) + TAIL (800) were fixed constants, so a value capped at CAP_INPUT (1024) came
 * out at roughly 2050 characters — larger than the cap it was enforcing. The caps exist to
 * stop a whole file body crossing IPC and landing in SQLite, so exceeding them silently was
 * the one thing this function must never do.
 */
describe('tool detail caps', () => {
  const bigInput = 'x'.repeat(50_000)

  it('keeps a capped tool input under the cap', () => {
    const st = createTranslatorState('s-clamp', 'claude-sonnet-5')
    const out = translate(
      {
        type: 'assistant',
        message: {
          id: 'm1',
          content: [
            { type: 'tool_use', id: 'tu1', name: 'Write', input: { body: bigInput } },
          ],
        },
      },
      st,
      ctx,
    )
    const start = out.find((e: AgentEvent) => e.type === 'agent:tool:start')
    expect(start).toBeDefined()
    if (start?.type === 'agent:tool:start') {
      const rendered = typeof start.input === 'string' ? start.input : JSON.stringify(start.input)
      expect(rendered.length, 'a capped input must be smaller than what went in').toBeLessThan(
        bigInput.length,
      )
      // The whole point: it must be near the cap, not double it.
      expect(rendered.length).toBeLessThan(1600)
    }
  })

  it('keeps both ends, because the failure is at the end', () => {
    const st = createTranslatorState('s-clamp2', 'claude-sonnet-5')
    const body = `FIRST${'-'.repeat(50_000)}LAST`
    const out = translate(
      {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu1',
              content: body,
            },
          ],
        },
      },
      st,
      ctx,
    )
    const end = out.find((e: AgentEvent) => e.type === 'agent:tool:end')
    if (end?.type === 'agent:tool:end' && end.raw) {
      expect(end.raw).toContain('FIRST')
      expect(end.raw, 'head-only truncation is useless for the case it exists to serve').toContain(
        'LAST',
      )
      expect(end.raw).toContain('elided')
      expect(end.raw.length).toBeLessThan(2600)
    }
  })
})

/**
 * Compacting.
 *
 * Auto-compact is on by default in the shipped CLI — verified: the gate is `DISABLE_COMPACT`
 * → `DISABLE_AUTO_COMPACT` → the `autoCompactEnabled` setting, which defaults to true. So a
 * long-running agent WILL compact, and everything downstream has to survive the context going
 * down instead of up, which is the one direction the meter never expected.
 */
describe('compaction', () => {
  const result = (window = 1_000_000): Record<string, unknown> => ({
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: 1,
    num_turns: 1,
    total_cost_usd: 1,
    usage: { input_tokens: 1, output_tokens: 1 },
    modelUsage: { 'claude-sonnet-4-6': { contextWindow: window } },
    result: 'done',
  })

  const boundary = (pre: number, post: number): Record<string, unknown> => ({
    type: 'system',
    subtype: 'compact_boundary',
    session_id: 's1',
    uuid: 'u1',
    compact_metadata: { trigger: 'auto', pre_tokens: pre, post_tokens: post },
  })

  it('lets the context go DOWN at a compact boundary', () => {
    const events = run([
      assistantWithUsage(187_000),
      boundary(187_000, 20_000),
      result(),
    ])
    const cost = events.find((e) => e.type === 'agent:cost')
    if (cost?.type !== 'agent:cost') throw new Error('no cost event')

    // The max-based accumulator would have reported 187k here, for the rest of the process.
    expect(cost.contextUsed).toBe(20_000)
  })

  it('resets the high-water mark on each turn, so a peak does not outlive it', () => {
    const st = createTranslatorState('s1', 'claude-sonnet-4-6')
    const init = { type: 'system', subtype: 'init', mcp_servers: [], session_id: 's1' }

    // A big first turn.
    translate(init as never, st, ctx, 1)
    translate(assistantWithUsage(400_000) as never, st, ctx, 1)
    const first = translate(result() as never, st, ctx, 1).find((e) => e.type === 'agent:cost')
    if (first?.type !== 'agent:cost') throw new Error('no cost event')
    expect(first.contextUsed).toBe(400_000)

    // A small second turn, after a compaction it did not see. The meter must follow.
    translate(init as never, st, ctx, 1)
    translate(assistantWithUsage(12_000) as never, st, ctx, 1)
    const second = translate(result() as never, st, ctx, 1).find((e) => e.type === 'agent:cost')
    if (second?.type !== 'agent:cost') throw new Error('no cost event')
    expect(second.contextUsed, 'a per-process max is a per-turn comment on per-process code').toBe(12_000)
  })

  it('explains the drop rather than leaving it unaccounted for', () => {
    const events = run([boundary(187_000, 20_000)])
    const d = events.find((e) => e.type === 'agent:degraded')
    if (d?.type !== 'agent:degraded') throw new Error('no degraded event')

    expect(d.reason).toBe('compacted')
    expect(d.detail).toMatch(/187k → 20k/)
    expect(d.detail).toMatch(/auto/)
  })

  it('shows the pause, because compaction takes minutes and otherwise looks like a hang', () => {
    const events = run([{ type: 'system', subtype: 'status', status: 'compacting' }])
    expect(events).toHaveLength(1)
    const t = events[0]!
    if (t.type !== 'agent:thinking') throw new Error('expected a thinking event')
    expect(t.phase).toBe('compacting')
  })

  it('survives a boundary with no post_tokens yet', () => {
    const events = run([
      assistantWithUsage(150_000),
      { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 150_000 } },
      result(),
    ])
    const cost = events.find((e) => e.type === 'agent:cost')
    if (cost?.type !== 'agent:cost') throw new Error('no cost event')

    // Better to report nothing than to keep reporting the pre-compaction figure.
    expect(cost.contextUsed).toBeUndefined()
  })
})
