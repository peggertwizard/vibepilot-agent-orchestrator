import { describe, expect, it } from 'vitest'
import { codexArgs, codexEnv } from '../src/main/providers/codex/argv'
import { CODEX_PREFIX } from '@shared/types'
import type { LaunchSpec } from '../src/main/providers/types'

function spec(over: Partial<LaunchSpec> = {}): LaunchSpec {
  return {
    runId: 'run-1',
    provider: 'codex',
    agentId: 'a1',
    projectId: 'p1',
    ticketId: 't1',
    parentAgentId: null,
    cwd: 'C:/work/wt/1',
    addDirs: [],
    model: 'codex',
    appendSystemPrompt: 'you are a teammate',
    permissionMode: 'bypassPermissions',
    mcp: null,
    sessionId: 's1',
    ...over,
  }
}

const MCP = { url: 'http://127.0.0.1:51234/mcp', token: 'sekrit-token-value' }

/**
 * The launch that turns Codex from a hire into a teammate.
 *
 * Every assertion here covers something that was simply *missing* before 0.5.0 — and missing is
 * the hardest kind of bug to see. A Codex teammate launched without tools looks identical to one
 * launched with them until it finishes work it has no way to report, at which point its route
 * step sits `active` for ever and the ticket is stuck. Nothing on screen said so.
 */
describe('attaching vibePilot to a Codex run', () => {
  it('passes the MCP server as per-invocation config', () => {
    const args = codexArgs(spec({ mcp: MCP }), null)
    expect(args).toContain(`mcp_servers.vibepilot.url="${MCP.url}"`)
    expect(args).toContain('mcp_servers.vibepilot.bearer_token_env_var="VIBEPILOT_MCP_TOKEN"')
  })

  /**
   * Connecting is not the same as being able to call anything.
   *
   * Codex gates MCP tool calls behind approval, and `codex exec` has nobody to ask, so it
   * auto-denies: the handshake succeeds, `tools/list` is served, the model decides to call a
   * tool, and the call dies inside Codex with "user cancelled MCP tool call" before it reaches
   * the server. Observed on a real run — every structural check passed while the teammate was
   * still, in practice, unable to report a single thing.
   */
  it('grants permission to call the tools it just attached', () => {
    expect(codexArgs(spec({ mcp: MCP }), null)).toContain(
      'mcp_servers.vibepilot.default_tools_approval_mode="approve"',
    )
  })

  /**
   * And nothing wider than that. Auto-approval is scoped to vibePilot's own server, so shell
   * commands and any other MCP server the user has configured stay gated as they were.
   */
  it('does not touch the global approval policy', () => {
    expect(codexArgs(spec({ mcp: MCP }), null).join(' ')).not.toContain('approval_policy')
  })

  /**
   * The token must not be readable from a process listing. `bearer_token_env_var` exists for
   * exactly this, so using it and then also putting the token in argv would defeat the point.
   */
  it('keeps the token out of the command line', () => {
    const args = codexArgs(spec({ mcp: MCP }), null)
    expect(args.join(' ')).not.toContain(MCP.token)
    expect(codexEnv(spec({ mcp: MCP }))['VIBEPILOT_MCP_TOKEN']).toBe(MCP.token)
  })

  /**
   * `-c` and not `codex mcp add`, which writes to `~/.codex/config.toml` and would leak
   * vibePilot's server into every Codex session the user ever runs by hand.
   */
  it('never writes to the user’s Codex config', () => {
    const args = codexArgs(spec({ mcp: MCP }), null)
    expect(args).not.toContain('mcp')
    expect(args).not.toContain('add')
    expect(args[0]).toBe('exec')
  })

  it('adds nothing when there is no MCP server to attach', () => {
    const args = codexArgs(spec({ mcp: null }), null)
    expect(args.join(' ')).not.toContain('mcp_servers')
    expect(codexEnv(spec({ mcp: null }))).not.toHaveProperty('VIBEPILOT_MCP_TOKEN')
    // Still a usable turn — no MCP is a degraded run, not a refused one.
    expect(args).toContain('exec')
  })

  /**
   * A future codex-cli that stops recognising these keys must fail loudly. Silently launching a
   * teammate with no tools is the precise failure this release exists to end.
   */
  it('refuses unknown config rather than launching without tools', () => {
    expect(codexArgs(spec({ mcp: MCP }), null)).toContain('--strict-config')
  })
})

describe('the model and effort a Codex teammate was given', () => {
  it('passes the chosen model', () => {
    const args = codexArgs(spec({ model: `${CODEX_PREFIX}gpt-5.6-sol` }), null)
    expect(args).toContain('-m')
    expect(args[args.indexOf('-m') + 1]).toBe('gpt-5.6-sol')
  })

  /** No specific model chosen: Codex uses its own configured default, which is correct. */
  it('passes no model when none was chosen', () => {
    expect(codexArgs(spec({ model: 'codex' }), null)).not.toContain('-m')
  })

  it('passes the effort, renamed for Codex', () => {
    expect(codexArgs(spec({ effort: 'high' }), null)).toContain('model_reasoning_effort="high"')
    expect(codexArgs(spec({ effort: 'ultracode' }), null)).toContain(
      'model_reasoning_effort="ultra"',
    )
  })

  it('passes no effort when none was set', () => {
    expect(codexArgs(spec({ effort: null }), null).join(' ')).not.toContain(
      'model_reasoning_effort',
    )
  })
})

describe('the rest of the turn', () => {
  it('resumes the thread when there is one, and does not otherwise', () => {
    expect(codexArgs(spec(), 'thread-abc')).toContain('resume')
    expect(codexArgs(spec(), 'thread-abc')).toContain('thread-abc')
    expect(codexArgs(spec(), null)).not.toContain('resume')
  })

  it('runs in the worktree and carries the extra directories', () => {
    const args = codexArgs(spec({ addDirs: ['C:/work/repo'] }), null)
    expect(args[args.indexOf('-C') + 1]).toBe('C:/work/wt/1')
    expect(args).toContain('--add-dir')
    expect(args).toContain('C:/work/repo')
  })

  /** The prompt goes over stdin — a multi-word argument is rejected by codex on Windows. */
  it('never puts the system prompt on the command line', () => {
    expect(codexArgs(spec({ mcp: MCP }), null).join(' ')).not.toContain('you are a teammate')
  })
})

/**
 * A teammate that cannot wait must not be asked to.
 *
 * `ask_user` blocks the tool call until a human answers, which is right for Claude — one
 * process spans many turns, so holding the call open costs nothing. Codex exits at the end of
 * every turn and kills a tool call long before a person has read the question, so from inside
 * the process the ask simply *failed*: *"ich warte nicht weiter auf eine nicht sichtbare
 * Tool-Abfrage"*. It had asked, the card was on screen, and it carried on guessing — the exact
 * outcome asking exists to prevent.
 */
describe('waiting for a human', () => {
  it('gives Codex a timeout long enough for a person to answer', () => {
    expect(codexArgs(spec({ mcp: MCP }), null)).toContain(
      'mcp_servers.vibepilot.tool_timeout_sec=600',
    )
  })
})
