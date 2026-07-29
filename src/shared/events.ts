/**
 * The frozen event vocabulary. Every provider adapter normalises onto exactly these ten
 * events; nothing downstream ever sees a raw CLI message shape. Adding a provider means
 * writing a translator, not touching the bus, the DB or the UI.
 */
import type { ProviderId } from './types'

export interface EventBase {
  /** Process-global monotonic, allocated synchronously at emit. Ordering key. */
  seq: number
  ts: number
  projectId: string
  agentId: string
  runId: string
  ticketId?: string | null
  parentAgentId?: string | null
  /**
   * Set when the CLI reported `parent_tool_use_id` — i.e. this came from an in-process
   * `Task` subagent. Render indented; do NOT create an `agents` row for it. vibePilot
   * agents are OS processes; CLI subagents are not.
   */
  subagentOf?: string | null
}

export type ErrorReason =
  | 'spawn_failed'
  | 'binary_not_found'
  | 'auth_required'
  | 'cli_error'
  | 'stalled'
  | 'stream_overflow'
  | 'silent_exit'
  | 'api_error'
  | 'mcp_failed'
  | 'crashed'
  | 'worktree_failed'

export type DegradedReason =
  | 'rate_limit'
  | 'mcp_unavailable'
  | 'quiet'
  | 'fallback_model'
  | 'noisy_stdout'
  | 'permission_denied'
  /**
   * The conversation was summarised to fit. Not a failure — the agent carries on — but it
   * loses detail, and the meter dropping by 150k for no visible reason needs an explanation.
   * The reason union is open-ended on purpose, so this costs none of the ten frozen types.
   */
  | 'compacted'

export interface AgentStarted extends EventBase {
  type: 'agent:started'
  provider: ProviderId
  model: string
  sessionId: string
  cwd: string
  tools: string[]
  mcpOk: boolean
  pid: number | null
}

export interface AgentThinking extends EventBase {
  type: 'agent:thinking'
  /** `compacting` can last several minutes and otherwise looks exactly like a hang. */
  phase: 'requesting' | 'reasoning' | 'compacting'
  delta?: string
  blockIndex?: number
}

export interface AgentText extends EventBase {
  type: 'agent:text'
  messageId: string | null
  blockIndex: number
  delta?: string
  /** Authoritative assembled text. Wins over accumulated deltas. */
  final?: string
  /**
   * This text is something *you* said to the teammate, not something it said.
   *
   * Typing into the watch drawer wrote straight to the agent's stdin and was recorded nowhere,
   * so the message vanished the instant you pressed Send — the teammate heard it and the
   * transcript showed no sign of it. An optional flag on the event that already carries text,
   * rather than an eleventh event type.
   */
  fromUser?: boolean
}

export interface AgentToolStart extends EventBase {
  type: 'agent:tool:start'
  toolUseId: string
  name: string
  input?: unknown
  /** Accumulated `input_json_delta` fragments — deliberately not valid JSON yet. */
  inputPartial?: string
  caller: 'direct' | 'subagent'
}

export interface AgentToolEnd extends EventBase {
  type: 'agent:tool:end'
  toolUseId: string
  name: string
  isError: boolean
  /** From `tool_use_result.durationMs` — the CLI measures it, we don't. */
  durationMs: number | null
  summary: string
  /** The tool's actual output, capped head+tail by the translator. */
  raw?: string
  /** True when `raw` had the middle elided. */
  truncated?: boolean
}

export interface AgentQuestion extends EventBase {
  type: 'agent:question'
  questionId: string
  prompt: string
  choices?: string[]
  blocking: boolean
}

export interface AgentDone extends EventBase {
  type: 'agent:done'
  terminal: 'completed' | 'killed' | 'stdin_closed' | 'budget'
  stopReason: string | null
  numTurns: number
  durationMs: number
  summary?: string | null
  resultText?: string | null
  /**
   * The session id as of this turn's end.
   *
   * `agent:started` fires once per process, so the id recorded at launch was assumed to hold
   * for the process's life. `/clear` breaks that: it starts a new session, and the stored
   * resume handle then points at one that no longer exists — the next resume fails silently.
   * Carrying it here fixes *any* mid-process change rather than just that one command.
   */
  sessionId?: string
}

export interface AgentError extends EventBase {
  type: 'agent:error'
  reason: ErrorReason
  message: string
  detail?: string
  recoverable: boolean
}

export interface AgentDegraded extends EventBase {
  type: 'agent:degraded'
  reason: DegradedReason
  detail?: string
  resetsAt?: number | null
}

export interface AgentCost extends EventBase {
  type: 'agent:cost'
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  costUsd: number
  /** Claude reports `total_cost_usd` even on a subscription; Codex needs a rate table. */
  costSource: 'provider' | 'estimated'
  model: string
  contextUsed?: number
  contextMax?: number
}

export type AgentEvent =
  | AgentStarted
  | AgentThinking
  | AgentText
  | AgentToolStart
  | AgentToolEnd
  | AgentQuestion
  | AgentDone
  | AgentError
  | AgentDegraded
  | AgentCost

export type AgentEventType = AgentEvent['type']

/** Domain-level changes the renderer must react to but which aren't agent stream events. */
export type DomainEvent =
  | { type: 'tickets:changed'; projectId: string }
  | { type: 'routes:changed'; projectId: string }
  | { type: 'drafts:changed'; projectId: string }
  | { type: 'agents:changed'; projectId: string }
  | { type: 'hires:changed'; projectId: string }
  | { type: 'epics:changed'; projectId: string }
  | { type: 'messages:changed'; projectId: string }
  | { type: 'comms:changed'; projectId: string }
  | { type: 'questions:changed'; projectId: string }
  | { type: 'memory:changed'; projectId: string }
  | { type: 'quota:changed'; projectId: string; resetsAt: number | null; status: string }

export interface BusBatch {
  events: AgentEvent[]
  domain: DomainEvent[]
  /** Set when text deltas were dropped under pressure; renderer should re-snapshot. */
  truncated: boolean
}
