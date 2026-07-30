import type { Finding, FindingSeverity } from '@shared/types'
import { all, get, id, now, run } from '../index'

type Row = Record<string, unknown>

function map(r: Row): Finding {
  return {
    id: r['id'] as string,
    ticketId: r['ticket_id'] as string,
    projectId: r['project_id'] as string,
    pass: r['pass'] as number,
    byAgentId: (r['by_agent_id'] as string | null) ?? null,
    severity: r['severity'] as FindingSeverity,
    summary: r['summary'] as string,
    detail: (r['detail'] as string) ?? '',
    file: (r['file'] as string | null) ?? null,
    line: (r['line'] as number | null) ?? null,
    resolvedAt: (r['resolved_at'] as number | null) ?? null,
    createdAt: r['created_at'] as number,
  }
}

export function listFindings(ticketId: string): Finding[] {
  return all<Row>(
    'SELECT * FROM ticket_findings WHERE ticket_id = ? ORDER BY pass, created_at',
    ticketId,
  ).map(map)
}

export function listOpenFindings(projectId: string): Finding[] {
  return all<Row>(
    'SELECT * FROM ticket_findings WHERE project_id = ? AND resolved_at IS NULL ORDER BY created_at',
    projectId,
  ).map(map)
}

export function addFindings(input: {
  ticketId: string
  projectId: string
  pass: number
  byAgentId: string | null
  items: Array<{
    severity?: FindingSeverity
    summary: string
    detail?: string
    file?: string | null
    line?: number | null
  }>
}): Finding[] {
  const out: Finding[] = []
  for (const f of input.items) {
    const fid = id()
    run(
      `INSERT INTO ticket_findings
         (id, ticket_id, project_id, pass, by_agent_id, severity, summary, detail, file, line, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      fid,
      input.ticketId,
      input.projectId,
      input.pass,
      input.byAgentId,
      f.severity ?? 'should',
      f.summary,
      f.detail ?? '',
      f.file ?? null,
      f.line ?? null,
      now(),
    )
    const r = get<Row>('SELECT * FROM ticket_findings WHERE id = ?', fid)
    if (r) out.push(map(r))
  }
  return out
}

export function resolveFindings(ticketId: string, upToPass: number): number {
  const r = run(
    'UPDATE ticket_findings SET resolved_at = ? WHERE ticket_id = ? AND pass <= ? AND resolved_at IS NULL',
    now(),
    ticketId,
    upToPass,
  )
  return r.changes
}

/** Rendered into the builder's next turn — this is what it actually acts on. */
export function renderFindings(findings: Finding[]): string {
  const open = findings.filter((f) => !f.resolvedAt)
  if (open.length === 0) return ''
  const order: FindingSeverity[] = ['must', 'should', 'nit']
  return [...open]
    .sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity))
    .map((f) => {
      const where = f.file ? ` — \`${f.file}${f.line ? `:${f.line}` : ''}\`` : ''
      return `- **[${f.severity}]** ${f.summary}${where}${f.detail ? `\n  ${f.detail}` : ''}`
    })
    .join('\n')
}
