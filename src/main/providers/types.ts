import type { AgentEvent } from '@shared/events'
import type { EffortLevel, ProviderId } from '@shared/types'

/**
 * What a provider can and cannot do. `AgentRun` branches on capabilities, never on
 * `ProviderId` — that is what lets Codex (spawn-per-turn, no deltas, no native cost) drop
 * in later beside Claude (persistent session, deltas, native cost) without a refactor.
 */
export interface ProviderCapabilities {
  /** Can one process handle many turns over stdin? Claude yes, Codex no. */
  persistentTurns: boolean
  partialText: boolean
  thinking: boolean
  /** Reports real cost, so no rate table is needed. */
  nativeCost: boolean
  /** Can we choose the session id before spawning? Enables crash-safe resume handles. */
  preMintableSessionId: boolean
  resume: 'flag' | 'subcommand' | 'none'
  mcpTransport: Array<'http' | 'stdio'>
  interrupt: 'stdin-control' | 'kill-only'
  sandbox: boolean
}

export const CLAUDE_CAPS: ProviderCapabilities = {
  persistentTurns: true,
  partialText: true,
  thinking: true,
  nativeCost: true,
  preMintableSessionId: true,
  resume: 'flag',
  mcpTransport: ['http', 'stdio'],
  // Verified: control_request/interrupt on stdin is ignored in 2.1.220.
  interrupt: 'kill-only',
  sandbox: false,
}

export interface McpAttachment {
  url: string
  token: string
}

export interface LaunchSpec {
  runId: string
  /** Which CLI to spawn. The ONLY place the app branches on provider identity. */
  provider: ProviderId
  agentId: string
  projectId: string
  ticketId: string | null
  parentAgentId: string | null
  cwd: string
  addDirs: string[]
  model: string
  /**
   * How hard to think. Passed as `--effort`, not via CLAUDE_CODE_EFFORT_LEVEL, so the level
   * lands in the recorded argv and is visible afterwards in `agent_runs`.
   */
  effort?: EffortLevel | null
  /** Composed prompt; written to a file rather than argv (see paths.runDir). */
  appendSystemPrompt: string
  permissionMode: 'acceptEdits' | 'bypassPermissions' | 'plan'
  /**
   * Whether this project's own `.claude/settings.json` may be loaded.
   *
   * Off unless the user has said that folder is trusted. A project's settings can carry hooks
   * that shell out at session start, and we spawn with `bypassPermissions`, so honouring them
   * for any folder that happens to be on disk is remote code execution by way of `git clone`.
   */
  trustProjectSettings?: boolean
  allowedTools?: string[]
  disallowedTools?: string[]
  mcp: McpAttachment | null
  /** Always pre-minted before spawn so a crash still leaves a --resume handle. */
  sessionId: string
  resumeSessionId?: string | null
  maxBudgetUsd?: number | null
}

export interface PromptPayload {
  text: string
  images?: Array<{ mediaType: string; base64: string }>
  /** `system-notice` payloads may be coalesced with each other; `user` never is. */
  channel?: 'user' | 'system-notice'
}

export type RunState =
  | 'spawning'
  | 'idle'
  | 'thinking'
  | 'working'
  | 'waiting_on_you'
  | 'paused'
  | 'stalled'
  | 'stopping'
  | 'exited'

export interface ProviderAdapter {
  readonly id: ProviderId
  readonly caps: ProviderCapabilities
  readonly state: RunState
  readonly pid: number | null
  readonly sessionId: string | null

  /**
   * Resolves when the process is up — NOT when the first turn completes.
   * `first` may be null to start the process without consuming a turn.
   */
  start(spec: LaunchSpec, first: PromptPayload | null): Promise<void>
  send(p: PromptPayload): void
  interrupt(): Promise<'interrupted' | 'unsupported'>
  stop(reason: string, graceMs?: number): Promise<void>
  kill(reason: string): Promise<void>
  onEvent(fn: (e: AgentEvent) => void): () => void
  /** Resolves when the process has exited. */
  readonly closed: Promise<number | null>
}
