import { bus } from '../bus'
import { recordAgentUsage, setResolvedModel } from '../db/repos/agents'
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

      case 'agent:degraded':
        if (e.reason === 'rate_limit') {
          // The only honest quota signal available — Anthropic exposes no plan-quota number.
          setProjectQuota(e.projectId, e.detail ?? 'limited', e.resetsAt ?? null)
        }
        break
    }
  })
}
