import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runDir } from '../../paths'
import type { LaunchSpec } from '../types'

/**
 * Build argv for a Claude Code run.
 *
 * Three things here are non-obvious and load-bearing:
 *
 * 1. `--verbose` is MANDATORY. Without it `--output-format stream-json` emits nothing
 *    useful. This is the single most common way to wire this up and get silence.
 *
 * 2. `--strict-mcp-config` + `--setting-sources project` are how we keep the user's global
 *    Claude config out of spawned agents. A developer's `~/.claude/settings.json` routinely
 *    carries a dozen MCP servers and SessionStart/PostToolUse hooks that shell out to
 *    arbitrary commands. Inheriting that would mean unpredictable tool surfaces, seconds of
 *    startup, and third-party callbacks firing on the user's private work.
 *
 * 3. The system prompt goes to a FILE, not argv. Windows caps a command line at 32,767
 *    chars and a composed prompt (identity + pilot.md + rules + board + roster) blows past
 *    that on a real project.
 */

/**
 * How long a vibePilot tool call may take before the transport gives up.
 *
 * The CLI's default request timeout is **60 seconds**. `ask_user` has to wait for a human, and
 * a human routinely takes longer than a minute — so every slow answer died at the protocol
 * layer, the agent got an opaque failure, and it guessed. Which is the exact outcome asking was
 * meant to prevent.
 *
 * Set per server rather than via MCP_TOOL_TIMEOUT so it applies to *our* server and nothing the
 * user has configured elsewhere. Verified against the shipped CLI: the http server schema
 * accepts `timeout` ("Per-server tool-call timeout in milliseconds. Overrides the
 * MCP_TOOL_TIMEOUT environment variable for this server"), values under 1000 are ignored, and
 * it is clamped to a very large ceiling — ten minutes is comfortably inside it.
 *
 * `askUser.ts` waits well under this and then returns success with `status: "pending"`, so even
 * if this number were ever wrong the design degrades to more polling, not a hard failure.
 */
const MCP_TIMEOUT_MS = 600_000
export function buildClaudeArgv(spec: LaunchSpec): string[] {
  const args: string[] = [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--include-partial-messages',
    '--verbose',
    '--strict-mcp-config',
    /*
     * Nothing, unless this project has been trusted.
     *
     * An empty list is accepted and loads no settings at all — verified against CLI 2.1.220 by
     * running a folder whose `.claude/settings.json` held a SessionStart hook: with
     * `--setting-sources project` the hook fired at spawn with no prompt, and with an empty list
     * it did not. Since every spawn path uses `bypassPermissions`, honouring an arbitrary
     * folder's settings meant cloning a repository was enough to run its code.
     *
     * Omitting the flag entirely is NOT the safe default — that falls back to loading user,
     * project and local together, which is strictly worse.
     */
    ...(spec.trustProjectSettings ? ['--setting-sources', 'project'] : ['--setting-sources=']),
  ]

  if (spec.resumeSessionId) {
    // NOTE: resume only works from the SAME cwd the session was created in — verified.
    args.push('--resume', spec.resumeSessionId)
  } else {
    args.push('--session-id', spec.sessionId)
  }

  args.push('--model', spec.model)
  args.push('--permission-mode', spec.permissionMode)

  /*
   * How hard to think.
   *
   * `--effort` rather than CLAUDE_CODE_EFFORT_LEVEL: the flag lands in the recorded argv, so
   * afterwards you can see what a run was asked to do. The env var is invisible there and would
   * silently outrank any future in-session /effort.
   *
   * `ultracode` is not a level the flag understands as more than an alias for xhigh — the full
   * behaviour (xhigh *plus* standing sub-agent orchestration) lives in a session setting, and
   * `--settings` composes with the `--setting-sources project` above.
   *
   * An unrecognised value is a warning, not an error, so passing this through is safe even if
   * the CLI's vocabulary shifts under us.
   */
  if (spec.effort) {
    if (spec.effort === 'ultracode') {
      args.push('--settings', JSON.stringify({ ultracode: true }))
    } else {
      args.push('--effort', spec.effort)
    }
  }

  if (spec.appendSystemPrompt.trim()) {
    const file = join(runDir(spec.runId), 'system.md')
    writeFileSync(file, spec.appendSystemPrompt, 'utf8')
    args.push('--append-system-prompt-file', file)
  }

  if (spec.mcp) {
    args.push(
      '--mcp-config',
      JSON.stringify({
        mcpServers: {
          vibepilot: {
            type: 'http',
            url: spec.mcp.url,
            headers: { Authorization: `Bearer ${spec.mcp.token}` },
            timeout: MCP_TIMEOUT_MS,
          },
        },
      }),
    )
  }

  for (const dir of spec.addDirs) args.push('--add-dir', dir)
  if (spec.allowedTools?.length) args.push('--allowedTools', spec.allowedTools.join(','))
  if (spec.disallowedTools?.length) args.push('--disallowedTools', spec.disallowedTools.join(','))
  if (spec.maxBudgetUsd) args.push('--max-budget-usd', String(spec.maxBudgetUsd))

  return args
}

/** Strip the bearer token before this argv is persisted to `agent_runs`. */
export function redactArgv(args: string[]): string[] {
  return args.map((a) =>
    a.includes('"Authorization"') ? a.replace(/Bearer [A-Za-z0-9_-]+/g, 'Bearer «redacted»') : a,
  )
}
