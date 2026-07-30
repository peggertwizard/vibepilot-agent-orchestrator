import { codexModelId } from '@shared/types'
import type { LaunchSpec } from '../types'
import { codexEffort } from './models'

/**
 * The command line for one Codex turn.
 *
 * Split out of the adapter for the same reason `claude/argv.ts` is: this is where the decisions
 * live, and the decisions are what want testing. Three of them — the model, the effort and the
 * MCP server — were simply absent until 0.5.0, and absent is invisible. A teammate launched
 * without tools looks exactly like a teammate launched with them right up until it finishes work
 * it cannot report, so these are now assertions in a test file rather than lines nobody reads.
 */
export function codexArgs(spec: LaunchSpec, sessionId: string | null): string[] {
  return [
    'exec',
    '--json',
    '--skip-git-repo-check',
    // Fail loudly if a future codex-cli stops recognising a key below. Launching a teammate
    // that silently has no tools is the exact failure this release exists to end, and it is
    // far better to refuse than to repeat it quietly.
    '--strict-config',
    '-C',
    spec.cwd,
    // Not a containment boundary on Windows (see CODEX_CAPS.sandbox) but still the right
    // request: on a platform where the helper exists, it is honoured.
    '-s',
    'workspace-write',
    ...(spec.addDirs.flatMap((d) => ['--add-dir', d])),
    /*
     * The model, which was never passed at all.
     *
     * `spec.model` was recorded, shown on the chip and then dropped — so whatever you chose
     * in the app had no relationship to what ran. Absent means Codex uses its own configured
     * default, which is the right behaviour for a teammate with nothing chosen.
     */
    ...(codexModelId(spec.model) ? ['-m', codexModelId(spec.model) as string] : []),
    // Same story: `--effort` reached Claude and nothing reached Codex. `ultracode` is
    // `ultra` here, and the CLI describes both as "reasoning plus task delegation".
    ...(spec.effort ? ['-c', `model_reasoning_effort="${codexEffort(spec.effort)}"`] : []),
    /*
     * vibePilot's own tools — the reason a Codex teammate can now finish a ticket.
     *
     * Without this it could do the work and had no way to report it: no `advance_step`, no
     * `mark_ready_to_merge`, no `ask_user`. The route step stayed `active`, the heal pass
     * restarted it once, and it stalled again. A hired teammate that turned every ticket it
     * touched into a stuck one.
     *
     * Passed as `-c` overrides rather than `codex mcp add`, which would write into the
     * user's `~/.codex/config.toml` and leak vibePilot into every Codex session they ever
     * run by hand. These last exactly as long as the process.
     *
     * The token goes in the environment, never argv — `bearer_token_env_var` exists for
     * this, and argv is readable from any process listing on the machine.
     */
    ...(spec.mcp
      ? [
          '-c',
          `mcp_servers.vibepilot.url="${spec.mcp.url}"`,
          '-c',
          'mcp_servers.vibepilot.bearer_token_env_var="VIBEPILOT_MCP_TOKEN"',
          /*
           * And permission to actually call them — the last inch, and the one that was almost
           * missed.
           *
           * Codex gates MCP tool calls behind approval. `codex exec` is non-interactive, so
           * there is nobody to approve, and it auto-denies: the run connects, lists the tools,
           * decides to call one, and the call dies client-side with "user cancelled MCP tool
           * call" before it ever leaves the process. On screen that is indistinguishable from
           * having no tools at all — which is the exact state this release exists to end, so
           * shipping it would have been shipping the bug back with more steps.
           *
           * Found by running it. `--strict-config` accepts the two keys above and the handshake
           * succeeds without this, so nothing short of watching a real turn would have shown it.
           *
           * Scoped to `mcp_servers.vibepilot` and nothing else. It grants a teammate the tools
           * vibePilot itself exposes — moving a ticket, asking a question, reporting a finding.
           * The global `approval_policy` is untouched, so shell commands and any other MCP
           * server the user has configured are still gated exactly as they were.
           */
          '-c',
          'mcp_servers.vibepilot.default_tools_approval_mode="approve"',
        ]
      : []),
    // Resume keeps the thread's context. Without it every turn re-reads from nothing,
    // which is the expensive failure mode for a Codex teammate on long work.
    ...(sessionId ? ['resume', sessionId] : []),
  ]
}

/**
 * The environment for one Codex turn.
 *
 * The MCP token lives here and **never in argv**. `bearer_token_env_var` exists precisely so a
 * credential does not end up in a command line, which any process listing on the machine can
 * read. Asserted in the tests rather than trusted to review.
 */
export function codexEnv(spec: LaunchSpec): Record<string, string> {
  return {
    VIBEPILOT_RUN_ID: spec.runId,
    ...(spec.mcp ? { VIBEPILOT_MCP_TOKEN: spec.mcp.token } : {}),
  }
}
