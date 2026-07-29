import { useEffect, useState } from 'react'
import type { Agent, EffortLevel, TicketDetail as Detail } from '@shared/types'
import {
  EFFORT_OPTIONS,
  MODEL_OPTIONS,
  STEP_BUDGET_USD,
  STEP_LABEL,
  TOKEN_WEIGHTS,
  effortDefaultFor,
  formatTokens,
  prettyModel,
  routeSummary,
} from '@shared/types'
import { Button, Input, Tag } from './ui'
import { Icon } from './ui/Icon'

/**
 * Opening a ticket.
 *
 * Clicking one used to do nothing: there was no detail pane, modal or drawer anywhere in the
 * renderer, and the only editable field on a ticket in the whole app was which lane it sat in,
 * changed by dragging it. Everything below was already recorded and rendered nowhere — the
 * body, the route rationale, per-step effort, the branch, the worktree, the cost.
 *
 * A **panel, not a modal**: a modal blocks the board behind it, and the reason to open a ticket
 * is usually to compare it with the others.
 *
 * This is the ticket *during and after*; the presentation card (plan 10) is the moment
 * *before*. They show overlapping information and are deliberately not the same surface —
 * one is transient and lives in the chat, this one is permanent and opens whenever you want it.
 */
export function TicketDetail({
  ticketId,
  projectId,
  agents,
  baseBranch,
  onClose,
}: {
  ticketId: string
  projectId: string
  agents: Agent[]
  baseBranch: string
  onClose: () => void
}) {
  const [d, setD] = useState<Detail | null>(null)
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [budget, setBudget] = useState('')

  const load = (): void => {
    void window.vibepilot.tickets.detail(ticketId).then((next) => {
      setD(next)
      if (next) {
        setTitle(next.ticket.title)
        setBody(next.ticket.body)
        setBudget(next.ticket.budgetUsd === null ? '' : String(next.ticket.budgetUsd))
      }
    })
  }
  useEffect(load, [ticketId])

  // Re-read when anything about this ticket moves. The detail is entirely derived, so there is
  // nothing to reconcile — just ask again.
  useEffect(
    () =>
      window.vibepilot.bus.subscribe((batch) => {
        if (batch.domain.some((e) => e.type === 'tickets:changed' || e.type === 'routes:changed')) {
          load()
        }
      }),
    [ticketId],
  )

  if (!d) return null
  const t = d.ticket
  const route = d.accepted ?? d.proposed
  const step = route?.steps.find((s) => s.status === 'active' || s.status === 'rework') ?? null
  const open = d.findings.filter((f) => !f.resolvedAt)

  const save = async (): Promise<void> => {
    await window.vibepilot.tickets.update(projectId, t.id, {
      title: title.trim() || t.title,
      body,
      budgetUsd: budget.trim() ? Math.max(0, Number(budget) || 0) : null,
    })
    setEditing(false)
    load()
  }

  /*
   * The weighted total, for the same reason it is weighted everywhere else: a raw sum counts
   * the same cached conversation once per API round-trip, which is where the 41× inflation came
   * from — 225k of distinct content reading as 9.27M.
   */
  const tokens = Math.round(
    d.spend.tokensIn * TOKEN_WEIGHTS.in +
      d.spend.tokensOut * TOKEN_WEIGHTS.out +
      d.spend.tokensCacheRead * TOKEN_WEIGHTS.cacheRead +
      d.spend.tokensCacheWrite * TOKEN_WEIGHTS.cacheWrite,
  )
  const allowed = t.budgetUsd ?? STEP_BUDGET_USD[step?.kind ?? 'build']

  return (
    <aside
      style={{
        position: 'absolute',
        top: 0,
        right: 0,
        bottom: 0,
        width: 420,
        maxWidth: '100%',
        zIndex: 25,
        background: 'var(--surface)',
        borderLeft: '1px solid var(--line)',
        boxShadow: 'var(--shadow-lg)',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
      }}
    >
      <header
        style={{
          flex: 'none',
          display: 'flex',
          alignItems: 'baseline',
          gap: 8,
          padding: '11px 13px',
          borderBottom: '1px solid var(--line)',
        }}
      >
        <span className="meta tnum">#{t.number}</span>
        <span style={{ flex: 1, font: '600 14px var(--font-heading)', minWidth: 0 }} className="ellip">
          {t.title}
        </span>
        {t.readyToMerge && <Tag tone="ok">ready</Tag>}
        <button
          onClick={onClose}
          aria-label="Close"
          style={{ border: 'none', background: 'transparent', color: 'var(--muted)', cursor: 'pointer' }}
        >
          <Icon name="close" size={13} />
        </button>
      </header>

      <div
        className="scroll-y"
        style={{ flex: 1, minHeight: 0, padding: 13, display: 'flex', flexDirection: 'column', gap: 15 }}
      >
        {/* The route, with the rationale that was shown once on the proposal card and never again. */}
        {route && (
          <Section title={routeSummary(route.steps)}>
            {route.rationale && (
              <p className="selectable" style={{ ...para, marginBottom: 4 }}>
                {route.rationale}
              </p>
            )}
            {route.steps.map((s) => {
              const who = agents.find((a) => a.id === s.assigneeAgentId) ?? null
              return (
                <div key={s.id} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 7, flexWrap: 'wrap' }}>
                    <span
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: 'var(--radius-sm)',
                        background:
                          s.status === 'done'
                            ? 'var(--ok)'
                            : s.status === 'pending'
                              ? 'var(--line)'
                              : 'var(--accent)',
                        flex: 'none',
                      }}
                    />
                    <span className="cap">{STEP_LABEL[s.kind]}</span>
                    <span style={{ fontSize: 12, fontWeight: 600 }}>{who?.name ?? 'nobody'}</span>
                    {who && (
                      <>
                        <span className="meta">{prettyModel(who.resolvedModel, who.model)}</span>
                        <span className="meta" style={{ color: 'var(--faint)' }}>
                          {who.effort ?? effortDefaultFor(who.role)}
                        </span>
                      </>
                    )}
                    <div style={{ flex: 1 }} />
                    {s.passes > 1 && <Tag tone="warn">pass {s.passes}</Tag>}
                    <span className="meta" style={{ color: 'var(--faint)' }}>
                      {s.status}
                    </span>
                  </div>
                  {/*
                    The note explaining why this step exists was reachable only by hovering a dot
                    and reading a native browser tooltip.
                  */}
                  {s.note && (
                    <div className="meta selectable" style={{ paddingLeft: 13, lineHeight: 1.5 }}>
                      {s.note}
                    </div>
                  )}
                  {/*
                    Model and effort are editable while the step has not started. Once it is
                    running, changing them would say something the live process cannot hear.
                  */}
                  {who && s.status === 'pending' && (
                    <div style={{ display: 'flex', gap: 6, paddingLeft: 13 }}>
                      <Pick
                        value={who.model}
                        options={MODEL_OPTIONS.map((m) => ({ id: m.id, label: m.label }))}
                        onPick={(id) =>
                          void window.vibepilot.agents
                            .update(projectId, who.id, { model: id })
                            .then(load)
                        }
                      />
                      <Pick
                        value={who.effort ?? effortDefaultFor(who.role)}
                        options={EFFORT_OPTIONS.map((e) => ({ id: e.id, label: e.label }))}
                        onPick={(id) =>
                          void window.vibepilot.agents
                            .update(projectId, who.id, { effort: id as EffortLevel })
                            .then(load)
                        }
                      />
                    </div>
                  )}
                </div>
              )
            })}
          </Section>
        )}

        {/* The body: the Pilot's brief, accepted by the update IPC and read by nobody. */}
        <Section
          title="What this is"
          action={
            editing ? (
              <div style={{ display: 'flex', gap: 5 }}>
                <Button height={22} kind="primary" onClick={() => void save()}>
                  Save
                </Button>
                <Button height={22} onClick={() => (setEditing(false), load())}>
                  Cancel
                </Button>
              </div>
            ) : (
              <Button height={22} onClick={() => setEditing(true)}>
                Edit
              </Button>
            )
          }
        >
          {editing ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <Input value={title} onChange={setTitle} height={28} />
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={7}
                placeholder="What needs doing, and anything the person doing it should know."
                style={area}
              />
              <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                <span className="meta">budget $</span>
                <Input value={budget} onChange={setBudget} height={24} placeholder={String(allowed)} />
              </div>
            </div>
          ) : t.body.trim() ? (
            <p className="selectable" style={{ ...para, whiteSpace: 'pre-wrap' }}>
              {t.body}
            </p>
          ) : (
            <p style={{ ...para, color: 'var(--faint)' }}>No description.</p>
          )}
        </Section>

        {/*
          From the diff, which is the only honest source. Teammates — the agents that edit files
          — never persist their tool calls, and the Pilot, which does, cannot write files.
        */}
        {d.files.length > 0 && (
          <Section title={`Files touched (${d.files.length})`}>
            {d.files.map((f) => (
              <div key={f.path} style={{ display: 'flex', gap: 7, alignItems: 'baseline' }}>
                <span className="meta tnum" style={{ width: 12, flex: 'none' }}>
                  {f.status}
                </span>
                <span className="mono ellip" style={{ fontSize: 11, flex: 1 }} title={f.path}>
                  {f.path}
                </span>
              </div>
            ))}
          </Section>
        )}

        {/* Severity and summary already rendered on the card. The explanation did not. */}
        {open.length > 0 && (
          <Section title={`To fix (${open.length})`}>
            {open.map((f) => (
              <div key={f.id} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <div style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}>
                  <Tag tone={f.severity === 'must' ? 'danger' : f.severity === 'should' ? 'warn' : 'neutral'}>
                    {f.severity}
                  </Tag>
                  <span style={{ fontSize: 12, flex: 1 }}>{f.summary}</span>
                  {f.file && (
                    <span className="meta mono">
                      {f.file.split(/[\\/]/).pop()}
                      {f.line ? `:${f.line}` : ''}
                    </span>
                  )}
                </div>
                {f.detail && (
                  <div className="meta selectable" style={{ lineHeight: 1.55 }}>
                    {f.detail}
                  </div>
                )}
              </div>
            ))}
          </Section>
        )}

        <Section title="Where it lives">
          <KV k="Branch" v={t.branch ?? 'none yet'} />
          <KV
            k="Commits"
            v={t.branch ? `${d.commitsAhead} ahead of ${baseBranch}` : '—'}
          />
          {t.worktreePath && (
            <div style={{ display: 'flex', gap: 8, fontSize: 11 }}>
              <span className="meta" style={{ width: 62, flex: 'none' }}>
                Working copy
              </span>
              <span className="mono ellip selectable" style={{ flex: 1 }} title={t.worktreePath}>
                {t.worktreePath}
              </span>
              <button
                onClick={() => void window.vibepilot.system.revealInExplorer(t.worktreePath!)}
                style={{
                  border: 'none',
                  background: 'transparent',
                  color: 'var(--muted)',
                  font: '400 10.5px var(--font-heading)',
                  textDecoration: 'underline',
                  cursor: 'pointer',
                }}
              >
                open
              </button>
            </div>
          )}
          {t.headSha && <KV k="Merged as" v={t.headSha.slice(0, 10)} />}
        </Section>

        {/*
          What the TEAM spent. The Pilot's routing and briefing overhead is not attributable:
          `pilot.ts` omits `ticket_id` from its usage_events insert entirely. Saying so is better
          than quietly under-reporting a number people will compare against their bill.
        */}
        <Section title="Spent">
          <div
            style={{ display: 'flex', gap: 10, alignItems: 'baseline' }}
            title={
              `${d.spend.turns} turn${d.spend.turns === 1 ? '' : 's'} by the team on this ticket.\n\n` +
              `The Pilot's own turns are not counted here — its spend is not attributed to a ` +
              `ticket, so this is what the people working it cost, not the whole story.`
            }
          >
            <span className="tnum" style={{ fontSize: 13, fontWeight: 600 }}>
              {formatTokens(tokens)} tok
            </span>
            <span className="meta tnum">
              ${d.spend.costUsd.toFixed(2)} of ${allowed.toFixed(2)}
            </span>
            <div style={{ flex: 1 }} />
            <span className="meta" style={{ color: 'var(--faint)' }}>
              team only
            </span>
          </div>
        </Section>
      </div>
    </aside>
  )
}

const para: React.CSSProperties = { fontSize: 12.5, lineHeight: 1.6, color: 'var(--ink-2)', margin: 0 }

const area: React.CSSProperties = {
  width: '100%',
  resize: 'vertical',
  border: '1px solid var(--line)',
  background: 'var(--paper)',
  color: 'var(--ink)',
  font: 'inherit',
  fontSize: 12,
  lineHeight: 1.6,
  padding: 7,
  outline: 'none',
}

function Section({
  title,
  action,
  children,
}: {
  title: string
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span className="cap" style={{ flex: 1 }}>
          {title}
        </span>
        {action}
      </div>
      {children}
    </section>
  )
}

function KV({ k, v }: { k: string; v: string }) {
  return (
    <div style={{ display: 'flex', gap: 8, fontSize: 11 }}>
      <span className="meta" style={{ width: 62, flex: 'none' }}>
        {k}
      </span>
      <span className="mono ellip selectable" style={{ flex: 1 }} title={v}>
        {v}
      </span>
    </div>
  )
}

/** A tiny inline dropdown, matching the one on the presentation card. */
function Pick({
  value,
  options,
  onPick,
}: {
  value: string
  options: Array<{ id: string; label: string }>
  onPick: (id: string) => void
}) {
  return (
    <select
      value={options.find((o) => o.id === value || o.label === value)?.id ?? ''}
      onChange={(e) => onPick(e.target.value)}
      style={{
        height: 21,
        border: '1px solid var(--line)',
        background: 'var(--paper)',
        color: 'var(--ink)',
        font: '400 10.5px var(--font-heading)',
        padding: '0 3px',
        outline: 'none',
      }}
    >
      {options.map((o) => (
        <option key={o.id} value={o.id}>
          {o.label}
        </option>
      ))}
    </select>
  )
}
