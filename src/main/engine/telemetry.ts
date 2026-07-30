import { bus } from '../bus'
import { clearAgentSession, recordAgentUsage, setResolvedModel } from '../db/repos/agents'
import { setProjectQuota } from '../db/repos/projects'

/**
 * One subscriber that records usage for EVERY agent, whatever launched it.
 *
 * This used to live duplicated in pilot.ts and teammate.ts, which meant any other launch
 * path (tests, future providers, restart-from-checkpoint) silently recorded nothing. There
 * is exactly one bus, so there should be exactly one place that persists what crosses it.
 */

let installed = false

export function installTelemetry(): void {
  if (installed) return
  installed = true

  bus.onAgent((e) => {
    switch (e.type) {
      case 'agent:started':
        // We launch with an alias ("sonnet"); this is what the CLI resolved it to.
        if (e.model) setResolvedModel(e.agentId, e.model)
        break

      case 'agent:cost':
        recordAgentUsage(e.agentId, {
          tokensIn: e.inputTokens,
          tokensOut: e.outputTokens,
          cacheRead: e.cacheReadTokens,
          cacheWrite: e.cacheCreationTokens,
          contextUsed: e.contextUsed ?? null,
          contextMax: e.contextMax ?? null,
          costUsd: e.costUsd,
        })
        break

      /*
       * A resume handle that can never work again.
       *
       * A Claude session belongs to the directory it was created in, so once a worktree is
       * removed or moved, `--resume` answers *"No conversation found with session ID: …"* and
       * will answer that for ever. The handle stayed on the agent row regardless, so every
       * automatic restart replayed the same dead id and failed identically — the log filled
       * with "carrying context — Restarted: resuming the interrupted session" followed by
       * "stopped: The model call failed", over and over, with nothing able to break the cycle.
       *
       * Dropping the handle costs the conversation and nothing else: the branch, the commits
       * and the brief are all still there, so the next start is a cold one that actually runs.
       */
      case 'agent:error':
        if (/No conversation found with session ID/i.test(e.message)) clearAgentSession(e.agentId)
        break

      case 'agent:degraded':
        if (e.reason === 'rate_limit') {
          // The only honest quota signal available — Anthropic exposes no plan-quota number.
          setProjectQuota(e.projectId, e.detail ?? 'limited', e.resetsAt ?? null)
        }
        break
    }
  })
}
