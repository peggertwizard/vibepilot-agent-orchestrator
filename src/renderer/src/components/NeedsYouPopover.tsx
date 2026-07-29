import { useEffect, useState } from 'react'
import type {
  Agent,
  Epic,
  HireProposal,
  Question,
  Ticket,
  TicketDraft,
  TicketRoute,
} from '@shared/types'
import { activeStep } from '@shared/types'
import { Icon } from './ui/Icon'

/**
 * One place for everything that is waiting on you.
 *
 * Before this, a decision's location depended entirely on what kind of decision it was.
 * Questions were prose in the message stream. Ticket drafts and route cards were in a tray.
 * Splits were on the board. Sign-off gates were on a ticket card you had to open. Merges were
 * in the right-hand rail behind a tab. The header carried a *"Needs you · 3"* button that
 * counted a different subset than the tray showed and jumped to whichever tab it guessed.
 *
 * The failure that made this unavoidable: the Pilot parked a build on two questions and asked
 * them **as chat prose**. Nothing badged, nothing persisted, nothing blocked — the questions
 * scrolled away and the ticket sat there. *"why am i not getting these questions delivered?
 * there should be something that does not simply disappear."*
 *
 * So: the count and the contents are the same list, the list is reachable from every tab, and
 * every entry either resolves in place or takes you to where it does. Nothing here scrolls
 * away, because nothing here is a message.
 */

export type NeedsYouKind =
  | 'question'
  | 'gate'
  | 'split'
  | 'route'
  | 'draft'
  | 'merge'
  | 'stuck'
  | 'hire'

export interface NeedsYouItem {
  id: string
  kind: NeedsYouKind
  title: string
  /** One line. Anything longer belongs behind the item's own disclosure. */
  summary: string
  /** Rendered when the item is opened — the existing cards, unchanged. */
  detail?: React.ReactNode
  /** Where this is dealt with, when it cannot be dealt with here. */
  go?: { tab: 'messages' | 'board' | 'team'; ticketId?: string; label: string }
}

const KIND_LABEL: Record<NeedsYouKind, string> = {
  question: 'a question',
  gate: 'your sign-off',
  split: 'a breakdown',
  route: 'how to handle it',
  draft: 'a new ticket',
  merge: 'ready to merge',
  stuck: 'stopped',
  hire: 'a teammate',
}

/** The ones where reading the card is not the point — you press one button and move on. */
const URGENT: NeedsYouKind[] = ['question', 'gate', 'stuck']

export function NeedsYouPopover({
  items,
  open,
  onClose,
  onGo,
}: {
  items: NeedsYouItem[]
  open: boolean
  onClose: () => void
  onGo: (item: NeedsYouItem) => void
}) {
  const [openItem, setOpenItem] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    const esc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [open, onClose])

  if (!open) return null

  return (
    <>
      {/*
        A full-screen catcher rather than a document-level click listener: it closes on the
        first click anywhere outside without that click also pressing whatever was underneath,
        which is the usual way a dismiss handler eats the button you were aiming for.
      */}
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 49 }} />
      <div
        role="dialog"
        aria-label="Waiting on you"
        style={{
          position: 'absolute',
          right: 20,
          top: 'calc(100% + 6px)',
          width: 'min(560px, calc(100vw - 60px))',
          maxHeight: '62vh',
          display: 'flex',
          flexDirection: 'column',
          border: '1px solid var(--accent)',
          background: 'var(--surface)',
          boxShadow: 'var(--shadow-lg)',
          zIndex: 50,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '9px 12px',
            borderBottom: '1px solid var(--line-2)',
            flex: 'none',
          }}
        >
          <span className="cap" style={{ color: 'var(--accent-ink)' }}>
            waiting on you
          </span>
          <div style={{ flex: 1 }} />
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              border: 'none',
              background: 'transparent',
              color: 'var(--faint)',
              cursor: 'pointer',
              padding: 2,
              display: 'inline-flex',
            }}
          >
            <Icon name="close" size={12} />
          </button>
        </div>

        <div className="scroll-y" style={{ minHeight: 0, padding: 10 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {items.map((it) => {
              // The urgent kinds open on arrival: their whole content is one button, and
              // hiding that behind a disclosure would be ceremony around a single press.
              const expanded = openItem === it.id || (openItem === null && URGENT.includes(it.kind))
              return (
                <div
                  key={it.id}
                  style={{
                    border: `1px solid ${URGENT.includes(it.kind) ? 'var(--accent)' : 'var(--line)'}`,
                    background: 'var(--paper)',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '9px 10px' }}>
                    <span style={{ display: 'flex', flexDirection: 'column', gap: 3, flex: 1, minWidth: 0 }}>
                      <span className="cap" style={{ color: 'var(--faint)' }}>
                        {KIND_LABEL[it.kind]}
                      </span>
                      <span style={{ font: '600 12.5px var(--font-heading)', lineHeight: 1.4 }}>
                        {it.title}
                      </span>
                      {it.summary && (
                        <span className="meta" style={{ lineHeight: 1.5, whiteSpace: 'normal' }}>
                          {it.summary}
                        </span>
                      )}
                    </span>
                    <span style={{ display: 'flex', gap: 6, flex: 'none', paddingTop: 2 }}>
                      {it.go && (
                        <button
                          onClick={() => onGo(it)}
                          className="meta"
                          style={{
                            border: '1px solid var(--line)',
                            background: 'transparent',
                            color: 'var(--ink-2)',
                            cursor: 'pointer',
                            padding: '2px 7px',
                          }}
                        >
                          {it.go.label}
                        </button>
                      )}
                      {it.detail && (
                        <button
                          onClick={() => setOpenItem(expanded ? '' : it.id)}
                          className="meta"
                          style={{
                            border: 'none',
                            background: 'transparent',
                            color: 'var(--faint)',
                            cursor: 'pointer',
                            padding: '2px 2px',
                          }}
                        >
                          {expanded ? 'less' : 'more'}
                        </button>
                      )}
                    </span>
                  </div>

                  {expanded && it.detail && (
                    <div style={{ padding: '0 10px 10px', borderTop: '1px solid var(--line-2)' }}>
                      {it.detail}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </>
  )
}

/**
 * Everything outstanding, in the order it should be dealt with.
 *
 * Ordered by what is blocked behind it. A question has a teammate stopped mid-run waiting for
 * an answer. A gate has a build parked. A breakdown holds up every ticket inside it; a route
 * holds up one. A merge is finished work. A hire can wait for any of them.
 *
 * Pure, and separate from the component, so the ordering and the derivations are testable
 * without rendering anything — the gate derivation in particular is the kind of thing that is
 * wrong in a way no screenshot reveals.
 */
export function buildNeedsYouItems(input: {
  questions: Question[]
  tickets: Ticket[]
  routes: TicketRoute[]
  drafts: TicketDraft[]
  epics: Epic[]
  hires: HireProposal[]
  agents: Agent[]
  render: {
    question: (q: Question) => React.ReactNode
    gate: (t: Ticket) => React.ReactNode
    split: (e: Epic) => React.ReactNode
    route: (r: { route: TicketRoute; ticket: Ticket }) => React.ReactNode
    draft: (d: TicketDraft) => React.ReactNode
    stuck: (a: Agent) => React.ReactNode
  }
  renderHire: (h: HireProposal) => React.ReactNode
}): NeedsYouItem[] {
  const out: NeedsYouItem[] = []
  const live = input.tickets.filter((t) => !t.archivedAt)
  const byId = new Map(live.map((t) => [t.id, t]))

  for (const q of input.questions) {
    const who = input.agents.find((a) => a.id === q.agentId)
    out.push({
      id: `question-${q.id}`,
      kind: 'question',
      title: q.question,
      summary: who ? `${who.name} is stopped until you answer.` : 'Someone is waiting on this.',
      detail: input.render.question(q),
      go: { tab: 'messages', label: 'In chat' },
    })
  }

  /*
   * A route parked at a sign-off.
   *
   * Derived rather than stored: the route has no active step and its next pending step is
   * gated. Both halves matter — without "no active step" a ticket whose plan is still running
   * would offer an Approve button for a build that cannot start yet.
   */
  for (const route of input.routes) {
    if (route.status !== 'accepted') continue
    if (activeStep(route)) continue
    const step = route.steps.find((s) => s.status === 'pending' && s.gate)
    if (!step) continue
    const ticket = byId.get(route.ticketId)
    if (!ticket) continue
    out.push({
      id: `gate-${route.id}`,
      kind: 'gate',
      title: `#${ticket.number} ${ticket.title}`,
      summary: `The ${step.kind} step is waiting for you to approve it. Nothing is built until you do.`,
      detail: input.render.gate(ticket),
      go: { tab: 'board', ticketId: ticket.id, label: 'Open ticket' },
    })
  }

  for (const e of input.epics) {
    out.push({
      id: `split-${e.id}`,
      kind: 'split',
      title: e.title,
      summary: `${e.pieces.length} pieces — ${e.summary}`,
      detail: input.render.split(e),
    })
  }

  for (const route of input.routes) {
    if (route.status !== 'proposed') continue
    const ticket = byId.get(route.ticketId)
    if (!ticket) continue
    out.push({
      id: `route-${route.id}`,
      kind: 'route',
      title: `#${ticket.number} ${ticket.title}`,
      summary: route.rationale,
      detail: input.render.route({ route, ticket }),
    })
  }

  for (const d of input.drafts) {
    out.push({
      id: `draft-${d.id}`,
      kind: 'draft',
      title: d.title,
      summary: d.body.split('\n')[0] ?? '',
      detail: input.render.draft(d),
    })
  }

  /*
   * Merges, grouped by branch.
   *
   * Two tickets built on top of each other share one branch and land in one squash-merge — the
   * engine has worked that way since branch grouping, and the UI still drew a card and a
   * button per ticket. Two "Merge into main" buttons for one merge, on two cards naming the
   * same branch, is a straightforward way to make somebody think they broke something.
   */
  const branches = new Map<string, Ticket[]>()
  for (const t of live) {
    if (!t.readyToMerge) continue
    const key = t.branch ?? `ticket:${t.id}`
    branches.set(key, [...(branches.get(key) ?? []), t])
  }
  for (const [key, group] of branches) {
    const [first, ...rest] = group
    if (!first) continue
    out.push({
      id: `merge-${key}`,
      kind: 'merge',
      title:
        rest.length === 0
          ? `#${first.number} ${first.title}`
          : `#${group.map((t) => t.number).join(' + #')} — ${group.length} tickets, one branch`,
      summary:
        rest.length === 0
          ? 'Finished and waiting to land.'
          : `They were built on top of each other, so one merge lands all ${group.length}.`,
      go: { tab: 'board', ticketId: first.id, label: 'Open ticket' },
    })
  }

  /*
   * Teammates that stopped and could not be restarted automatically.
   *
   * `heal.ts` gets one attempt per teammate per app run; past that it is a person's decision,
   * and this is where the person finds out.
   */
  for (const a of input.agents) {
    if (a.isPilot) continue
    if (a.status !== 'stalled' && a.status !== 'error') continue
    const ticket = live.find((t) => t.assigneeAgentId === a.id)
    if (!ticket) continue
    out.push({
      id: `stuck-${a.id}`,
      kind: 'stuck',
      title: `${a.name} stopped on #${ticket.number}`,
      summary: a.statusLine ?? 'Nothing is running it.',
      detail: input.render.stuck(a),
      go: { tab: 'board', ticketId: ticket.id, label: 'Open ticket' },
    })
  }

  for (const h of input.hires) {
    out.push({
      id: `hire-${h.id}`,
      kind: 'hire',
      title: h.name,
      summary: h.why,
      detail: input.renderHire(h),
    })
  }

  return out
}
