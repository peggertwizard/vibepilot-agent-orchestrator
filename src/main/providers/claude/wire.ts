/**
 * Shapes observed on the wire from `claude --output-format stream-json --verbose`,
 * version 2.1.220. Captured, not guessed — see docs/architecture/00-spikes.md.
 *
 * Everything is optional because the CLI self-updates and we must degrade rather than
 * throw when a field moves. The translator treats an unrecognised message as a no-op.
 */

export interface WireSystemInit {
  type: 'system'
  subtype: 'init'
  cwd?: string
  session_id?: string
  tools?: string[]
  /** The single best signal that our MCP bridge failed to attach. */
  mcp_servers?: Array<{ name: string; status: string }>
  model?: string
  permissionMode?: string
  claude_code_version?: string
  uuid?: string
}

export interface WireSystemStatus {
  type: 'system'
  subtype: 'status'
  status?: string
}

export interface WirePostTurnSummary {
  type: 'system'
  subtype: 'post_turn_summary'
  summarizes_uuid?: string
  status_category?: string
  /** Model-authored one-liner — exactly what the Agents panel wants. */
  status_detail?: string
  needs_action?: string
}

export interface WireStreamEvent {
  type: 'stream_event'
  session_id?: string
  parent_tool_use_id?: string | null
  uuid?: string
  event?: {
    type?: string
    index?: number
    message?: { id?: string }
    content_block?: {
      type?: string
      id?: string
      name?: string
      input?: unknown
      caller?: { type?: string }
    }
    delta?: {
      type?: string
      text?: string
      thinking?: string
      partial_json?: string
    }
  }
}

export interface WireAssistant {
  type: 'assistant'
  session_id?: string
  parent_tool_use_id?: string | null
  message?: {
    id?: string
    content?: Array<{
      type?: string
      text?: string
      id?: string
      name?: string
      input?: unknown
      thinking?: string
    }>
  }
}

export interface WireUser {
  type: 'user'
  session_id?: string
  parent_tool_use_id?: string | null
  message?: {
    content?: Array<{
      type?: string
      tool_use_id?: string
      is_error?: boolean
      content?: unknown
    }>
  }
  /** Sidecar not present in the Anthropic API. `durationMs` is authoritative timing. */
  tool_use_result?: {
    durationMs?: number
    numFiles?: number
    numLines?: number
    totalMatches?: number
    filenames?: string[]
    truncated?: boolean
    [k: string]: unknown
  }
}

export interface WireRateLimit {
  type: 'rate_limit_event'
  rate_limit_info?: {
    status?: string
    resetsAt?: number
    rateLimitType?: string
    overageStatus?: string
    isUsingOverage?: boolean
  }
}

export interface WireResult {
  type: 'result'
  subtype?: string
  is_error?: boolean
  duration_ms?: number
  num_turns?: number
  stop_reason?: string | null
  session_id?: string
  /** Populated even on a Max subscription — notional, not billed. */
  total_cost_usd?: number
  usage?: {
    input_tokens?: number
    output_tokens?: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
  }
  modelUsage?: Record<string, { contextWindow?: number; maxOutputTokens?: number }>
  permission_denials?: unknown[]
  terminal_reason?: string
  api_error_status?: number
  result?: string
  uuid?: string
}

export type WireMessage =
  | WireSystemInit
  | WireSystemStatus
  | WirePostTurnSummary
  | WireStreamEvent
  | WireAssistant
  | WireUser
  | WireRateLimit
  | WireResult
  | { type: string; [k: string]: unknown }
