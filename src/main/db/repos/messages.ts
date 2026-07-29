import type {
  Attachment,
  Comm,
  Message,
  MessageKind,
  MessageUsage,
  Question,
  ToolSummary,
} from '@shared/types'
import { all, get, id, json, now, parseJson, run } from '../index'

type Row = Record<string, unknown>

/* ── messages ───────────────────────────────────────────────────────────────── */

/**
 * Absent, not zero.
 *
 * A killed turn never reports usage, and rendering that as "0 tok" would state something
 * false about a number the user is reading to make a decision.
 */
function mapUsage(r: Row): MessageUsage | null {
  const input = r['tokens_in'] as number | null
  if (input == null) return null
  return {
    inputTokens: input,
    outputTokens: (r['tokens_out'] as number | null) ?? 0,
    cacheReadTokens: (r['tokens_cache_read'] as number | null) ?? 0,
    cacheCreationTokens: (r['tokens_cache_write'] as number | null) ?? 0,
  }
}

function map(r: Row): Message {
  return {
    id: r['id'] as string,
    projectId: r['project_id'] as string,
    agentId: (r['agent_id'] as string | null) ?? null,
    authorType: r['author_type'] as Message['authorType'],
    kind: r['kind'] as MessageKind,
    body: (r['body'] as string) ?? '',
    toolSummaries: parseJson<ToolSummary[]>(r['tool_summary_json'], []),
    attachments: parseJson<Attachment[]>(r['attachments_json'], []),
    usage: mapUsage(r),
    createdAt: r['created_at'] as number,
  }
}

export function listMessages(projectId: string, limit = 300): Message[] {
  return all<Row>(
    'SELECT * FROM (SELECT * FROM messages WHERE project_id = ? ORDER BY created_at DESC LIMIT ?) ORDER BY created_at',
    projectId,
    limit,
  ).map(map)
}

export function addMessage(input: {
  projectId: string
  agentId?: string | null
  runId?: string | null
  authorType: Message['authorType']
  kind?: MessageKind
  body: string
  providerMsgId?: string | null
  toolSummaries?: ToolSummary[]
  usage?: MessageUsage | null
  attachments?: Attachment[]
}): Message {
  const mid = id()
  run(
    `INSERT INTO messages
       (id, project_id, agent_id, run_id, author_type, kind, body, provider_msg_id,
        tool_summary_json, attachments_json, tokens_in, tokens_out, tokens_cache_read,
        tokens_cache_write, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    mid,
    input.projectId,
    input.agentId ?? null,
    input.runId ?? null,
    input.authorType,
    input.kind ?? 'text',
    input.body,
    input.providerMsgId ?? null,
    json(input.toolSummaries ?? []),
    json(input.attachments ?? []),
    input.usage?.inputTokens ?? null,
    input.usage?.outputTokens ?? null,
    input.usage?.cacheReadTokens ?? null,
    input.usage?.cacheCreationTokens ?? null,
    now(),
  )
  return map(get<Row>('SELECT * FROM messages WHERE id = ?', mid)!)
}

/** Append tool summaries to the most recent agent message, for the collapsible log. */
export function attachToolSummaries(messageId: string, add: ToolSummary[]): void {
  const r = get<Row>('SELECT tool_summary_json FROM messages WHERE id = ?', messageId)
  if (!r) return
  const cur = parseJson<ToolSummary[]>(r['tool_summary_json'], [])
  run('UPDATE messages SET tool_summary_json = ? WHERE id = ?', json([...cur, ...add]), messageId)
}

/* ── comms ──────────────────────────────────────────────────────────────────── */

function mapComm(r: Row): Comm {
  return {
    id: r['id'] as string,
    projectId: r['project_id'] as string,
    kind: r['kind'] as Comm['kind'],
    fromAgentId: (r['from_agent_id'] as string | null) ?? null,
    toAgentId: (r['to_agent_id'] as string | null) ?? null,
    severity: r['severity'] as Comm['severity'],
    body: r['body'] as string,
    ticketId: (r['ticket_id'] as string | null) ?? null,
    readAt: (r['read_at'] as number | null) ?? null,
    createdAt: r['created_at'] as number,
  }
}

export function listComms(projectId: string, limit = 400): Comm[] {
  return all<Row>(
    'SELECT * FROM (SELECT * FROM comms WHERE project_id = ? ORDER BY created_at DESC LIMIT ?) ORDER BY created_at',
    projectId,
    limit,
  ).map(mapComm)
}

export function addComm(input: {
  projectId: string
  kind: Comm['kind']
  fromAgentId: string | null
  toAgentId?: string | null
  severity?: Comm['severity']
  body: string
  ticketId?: string | null
}): Comm {
  const cid = id()
  run(
    `INSERT INTO comms (id, project_id, kind, from_agent_id, to_agent_id, severity, body, ticket_id, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    cid,
    input.projectId,
    input.kind,
    input.fromAgentId,
    input.toAgentId ?? null,
    input.severity ?? 'info',
    input.body,
    input.ticketId ?? null,
    now(),
  )
  return mapComm(get<Row>('SELECT * FROM comms WHERE id = ?', cid)!)
}

/* ── questions ──────────────────────────────────────────────────────────────── */

function mapQ(r: Row): Question {
  return {
    id: r['id'] as string,
    projectId: r['project_id'] as string,
    agentId: r['agent_id'] as string,
    ticketId: (r['ticket_id'] as string | null) ?? null,
    question: r['question'] as string,
    context: (r['context'] as string | null) ?? null,
    choices: parseJson<string[]>(r['choices_json'], []),
    urgency: r['urgency'] as Question['urgency'],
    status: r['status'] as Question['status'],
    answer: (r['answer'] as string | null) ?? null,
    answeredBy: (r['answered_by'] as Question['answeredBy']) ?? null,
    pilotAskedAt: (r['pilot_asked_at'] as number | null) ?? null,
    askedAt: r['asked_at'] as number,
    answeredAt: (r['answered_at'] as number | null) ?? null,
  }
}

export function listOpenQuestions(projectId: string): Question[] {
  return all<Row>(
    "SELECT * FROM questions WHERE project_id = ? AND status = 'open' ORDER BY asked_at",
    projectId,
  ).map(mapQ)
}

/**
 * Open questions per project, for the sidebar badge.
 *
 * Across all projects on purpose: the whole failure this fixes is that a question raised on the
 * project you are not looking at was invisible.
 */
export function openQuestionCounts(): Record<string, number> {
  const rows = all<Row>(
    "SELECT project_id, COUNT(*) AS n FROM questions WHERE status = 'open' GROUP BY project_id",
  )
  const out: Record<string, number> = {}
  for (const r of rows) out[r['project_id'] as string] = r['n'] as number
  return out
}

export function getQuestion(questionId: string): Question | null {
  const r = get<Row>('SELECT * FROM questions WHERE id = ?', questionId)
  return r ? mapQ(r) : null
}

export function addQuestion(input: {
  projectId: string
  agentId: string
  ticketId?: string | null
  question: string
  context?: string | null
  choices?: string[]
  urgency?: Question['urgency']
}): Question {
  const qid = id()
  run(
    `INSERT INTO questions (id, project_id, agent_id, ticket_id, question, context, choices_json, urgency, asked_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    qid,
    input.projectId,
    input.agentId,
    input.ticketId ?? null,
    input.question,
    input.context ?? null,
    json(input.choices ?? []),
    input.urgency ?? 'blocking',
    now(),
  )
  return getQuestion(qid)!
}

/**
 * Record an answer. First writer wins.
 *
 * The `status = 'open'` guard is the whole race protocol: you and the Pilot may both be typing
 * an answer, and whichever UPDATE lands first is the one the teammate receives. The second is a
 * silent no-op, which is exactly right — it needs no lock, no take-it-back button, and no timer.
 */
export function answerQuestion(
  questionId: string,
  answer: string,
  by: 'user' | 'pilot' = 'user',
): Question | null {
  run(
    `UPDATE questions SET status = 'answered', answer = ?, answered_by = ?, answered_at = ?
     WHERE id = ? AND status = 'open'`,
    answer,
    by,
    now(),
    questionId,
  )
  return getQuestion(questionId)
}

/**
 * Hand a question to the Pilot without closing it.
 *
 * A timestamp rather than a status, because delegating must not take the question away from
 * you. The card stays live and answering it yourself still works.
 */
export function markQuestionAskedPilot(questionId: string): Question | null {
  run(
    "UPDATE questions SET pilot_asked_at = ? WHERE id = ? AND status = 'open'",
    now(),
    questionId,
  )
  return getQuestion(questionId)
}

/**
 * The asking process died. Close its open questions.
 *
 * This function existed with no callers, which is why a crashed teammate left a card on screen
 * with working buttons: you could answer it, the answer was persisted, and nothing on earth
 * consumed it. Two comments claimed the answer was "injected on resume" — no such path was ever
 * built. Orphaning is the honest outcome: the question disappears because nobody is listening.
 */
export function orphanQuestionsForAgent(agentId: string): number {
  return run(
    "UPDATE questions SET status = 'orphaned' WHERE agent_id = ? AND status = 'open'",
    agentId,
  ).changes
}
