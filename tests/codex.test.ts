import { describe, expect, it } from 'vitest'
import {
  createCodexState,
  translateCodex,
  type CodexWireEvent,
} from '../src/main/providers/codex/translate'
import { CODEX_CAPS } from '../src/main/providers/codex/adapter'

/**
 * Every fixture here is a **verbatim** shape from `docs/architecture/01-codex-spike.md`,
 * which drove a real `codex exec --json` through four cases. That matters more than usual:
 * the previous plan for this adapter was written having only ever observed `agent_message`,
 * and two of its claims turned out to be wrong when checked.
 *
 * The translator is pure, so this is the whole contract — if a Codex release changes the
 * wire, these fail rather than the app quietly rendering nothing.
 */

const ctx = {
  seq: (() => {
    let n = 0
    return () => ++n
  })(),
  projectId: 'p1',
  agentId: 'a1',
  runId: 'r1',
  ticketId: 't1',
  parentAgentId: null,
}

const run = (events: CodexWireEvent[], model = 'codex') => {
  const st = createCodexState(model)
  return events.flatMap((e) => translateCodex(e, st, ctx, 1234))
}

describe('the Codex translator', () => {
  it('turns thread.started into a started event carrying the resume handle', () => {
    const out = run([
      { type: 'thread.started', thread_id: '019fa90b-e283-79a0-99c6-245e22cfa593' },
    ])
    expect(out).toHaveLength(1)
    const e = out[0]!
    expect(e.type).toBe('agent:started')
    if (e.type !== 'agent:started') return
    expect(e.sessionId).toBe('019fa90b-e283-79a0-99c6-245e22cfa593')
    expect(e.provider).toBe('codex')
    // We attach our MCP server separately and cannot see from here whether it connected.
    // Claiming true would be a lie the UI would repeat.
    expect(e.mcpOk).toBe(false)
  })

  it('an agent_message arrives whole, as final text with no deltas', () => {
    const out = run([
      { type: 'item.started', item: { id: 'item_0', type: 'agent_message' } },
      { type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'pong' } },
    ])
    // item.started for a message produces NOTHING: there is no text yet, and an empty text
    // event would put a blank bubble in the chat.
    expect(out).toHaveLength(1)
    const e = out[0]!
    expect(e.type).toBe('agent:text')
    if (e.type !== 'agent:text') return
    expect(e.final).toBe('pong')
    expect(e.delta).toBeUndefined()
  })

  it('a shell command becomes a tool start and end', () => {
    const out = run([
      {
        type: 'item.started',
        item: { id: 'item_1', type: 'command_execution', command: 'git status --short' },
      },
      {
        type: 'item.completed',
        item: {
          id: 'item_1',
          type: 'command_execution',
          command: 'git status --short',
          aggregated_output: '',
          exit_code: 0,
          status: 'completed',
        },
      },
    ])
    expect(out.map((e) => e.type)).toEqual(['agent:tool:start', 'agent:tool:end'])
    const end = out[1]!
    if (end.type !== 'agent:tool:end') return
    expect(end.name).toBe('Bash')
    expect(end.isError).toBe(false)
    // Codex does not time its tools. Inventing a number would be worse than admitting it.
    expect(end.durationMs).toBeNull()
  })

  it('a non-zero exit is reported as a tool error', () => {
    const out = run([
      {
        type: 'item.completed',
        item: {
          id: 'item_2',
          type: 'command_execution',
          command: 'git checkout does-not-exist',
          exit_code: 1,
          status: 'completed',
        },
      },
    ])
    const e = out[0]!
    expect(e.type).toBe('agent:tool:end')
    if (e.type !== 'agent:tool:end') return
    expect(e.isError, 'status "completed" with exit_code 1 is still a failure').toBe(true)
  })

  it("file edits arrive as mcp_tool_call — Codex has no edit event of its own", () => {
    const out = run([
      {
        type: 'item.completed',
        item: {
          id: 'item_3',
          type: 'mcp_tool_call',
          server: 'node_repl',
          tool: 'js',
          arguments: { code: 'await fs.writeFile(...)', title: 'Inspect greet module' },
          result: { content: [{ type: 'text', text: 'ok' }] },
          error: null,
          status: 'completed',
        },
      },
    ])
    const e = out[0]!
    expect(e.type).toBe('agent:tool:end')
    if (e.type !== 'agent:tool:end') return
    expect(e.name).toBe('node_repl__js')
    expect(e.summary, 'the title reads better in a tool log than the code').toBe(
      'Inspect greet module',
    )
    expect(e.isError).toBe(false)
  })

  it('turn.completed reports usage — the plan was wrong that it does not', () => {
    const out = run([
      {
        type: 'turn.completed',
        usage: {
          input_tokens: 18995,
          cached_input_tokens: 100,
          cache_write_input_tokens: 50,
          output_tokens: 5,
          reasoning_output_tokens: 40,
        },
      },
    ])
    expect(out.map((e) => e.type)).toEqual(['agent:cost', 'agent:done'])
    const cost = out[0]!
    if (cost.type !== 'agent:cost') return
    expect(cost.inputTokens).toBe(18995)
    // Reasoning tokens are billed as output and invisible otherwise. Dropping them would
    // under-report a Codex teammate against a Claude one on the same board.
    expect(cost.outputTokens).toBe(45)
    expect(cost.cacheReadTokens).toBe(100)
    expect(cost.cacheCreationTokens).toBe(50)
    // No dollar figure is reported, and we do not invent one.
    expect(cost.costUsd).toBe(0)
    expect(cost.costSource).toBe('estimated')
    /*
     * Half the fact, reported as half the fact.
     *
     * Codex says what it sent, and every turn re-uploads the whole conversation, so that total
     * *is* the context in use. It does not say how large the window is: not in `model/list`,
     * and `config/read` answers `model_context_window: null` because that key is a user
     * override rather than the model's real size.
     *
     * So the numerator is real and the denominator is absent. The only way to produce a
     * percentage would be a window hardcoded per model — the same trap as a hardcoded model
     * list, stale in silence and authoritative-looking while it is. A bar reading 40% against
     * an invented maximum is worse than a number that stops.
     */
    expect(cost.contextUsed).toBe(18995)
    expect(cost.contextMax).toBeUndefined()
  })

  /** Nothing sent, nothing claimed. A zero would draw a reading that means "not measured". */
  it('claims no context when the turn reported no input tokens', () => {
    const out = run([{ type: 'turn.completed', usage: { output_tokens: 5 } }])
    const cost = out[0]!
    if (cost.type !== 'agent:cost') return
    expect(cost.contextUsed).toBeUndefined()
  })

  it('a full turn produces a coherent sequence', () => {
    const out = run([
      { type: 'thread.started', thread_id: 'abc123def456abc7' },
      { type: 'turn.started' },
      { type: 'item.started', item: { id: 'i1', type: 'command_execution', command: 'ls' } },
      { type: 'item.completed', item: { id: 'i1', type: 'command_execution', exit_code: 0 } },
      { type: 'item.completed', item: { id: 'i2', type: 'agent_message', text: 'done' } },
      { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } },
    ])
    expect(out.map((e) => e.type)).toEqual([
      'agent:started',
      'agent:thinking',
      'agent:tool:start',
      'agent:tool:end',
      'agent:text',
      'agent:cost',
      'agent:done',
    ])
  })

  it('ignores shapes it does not know rather than throwing mid-turn', () => {
    expect(run([{ type: 'some.future.event' } as CodexWireEvent])).toEqual([])
    expect(run([{} as CodexWireEvent])).toEqual([])
    expect(run([null as unknown as CodexWireEvent])).toEqual([])
    expect(run([{ type: 'item.completed' }])).toEqual([])
  })

  it('the capability table records what was verified, not what was hoped', () => {
    expect(CODEX_CAPS.persistentTurns).toBe(false)
    expect(CODEX_CAPS.partialText).toBe(false)
    expect(CODEX_CAPS.resume).toBe('subcommand')
    // The plan called the OS sandbox Codex's one genuine advantage. On Windows the helper
    // binary is not shipped, the launch fails, and the command runs anyway — so a Codex
    // teammate is NOT contained, and the UI must not imply it is.
    expect(CODEX_CAPS.sandbox).toBe(false)
  })
})
