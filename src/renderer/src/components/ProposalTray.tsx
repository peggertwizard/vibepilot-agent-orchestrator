import { useEffect, useRef, useState } from 'react'
import type { Epic, HireProposal, Ticket, TicketDraft, TicketRoute } from '@shared/types'
import { Icon } from './ui/Icon'

/**
 * One place for everything waiting on you.
 *
 * Before this, three kinds of proposal lived in two different screens: ticket drafts and route
 * cards rendered **only** inside the Messages stream, split proposals **only** on the Board.
 * So the two tabs showed different subsets of the same idea, acting in one place left the other
 * showing a stale copy, and pressing *Create 3 tickets* on the Board threw you back to Messages
 * to find three more cards waiting.
 *
 * That was never a synchronisation bug and could not have been fixed by synchronising: they
 * were two surfaces over different tables. This is one surface. Acting on something removes it
 * everywhere because there is only one everywhere.
 *
 * It sits above whichever tab you are on, so deciding never costs a tab switch — the thing
 * that made a three-piece request feel like an errand.
 *
 * **In the flow, not floating.** The first version was `position: absolute` pinned
 * bottom-right, which put it on top of the composer, the agents rail and whatever else was
 * underneath — *"overlaying over everything inconveniently"*. An overlay is the wrong shape
 * for something that can be there for minutes: it covers work you are trying to look at while
 * you decide. A bar that takes its own row costs a few pixels and blocks nothing.
 */

export interface TrayItem {
  id: string
  /** What kind of decision this is, for the label. */
  kind: 'draft' | 'route' | 'split' | 'hire'
  title: string
  /** One line. The detail lives behind the card's own disclosure. */
  summary: string
  /** Rendered when the item is opened. The existing card components, unchanged. */
  detail: React.ReactNode
}

const KIND_LABEL: Record<TrayItem['kind'], string> = {
  draft: 'new ticket',
  route: 'how to handle it',
  split: 'a breakdown',
  hire: 'a teammate',
}

export function ProposalTray({ items }: { items: TrayItem[] }) {
  /**
   * Opens when the first proposal arrives, and stays where you put it after that.
   *
   * A proposal that appears silently behind a collapsed bar is the "nothing waiting on you"
   * problem again — a confident wrong answer. But a tray that re-opens itself every time the
   * Pilot writes anything is worse, so it only reacts to the transition from *nothing waiting*
   * to *something waiting*. Closing it while three things are queued keeps it closed; the
   * fourth does not reopen it.
   */
  const [open, setOpen] = useState(false)
  const [openItem, setOpenItem] = useState<string | null>(null)
  const had = useRef(0)
  useEffect(() => {
    if (had.current === 0 && items.length > 0) setOpen(true)
    had.current = items.length
  }, [items.length])

  if (items.length === 0) return null

  return (
    <div
      style={{
        flex: 'none',
        display: 'flex',
        flexDirection: 'column',
        borderBottom: '1px solid var(--accent)',
        background: 'var(--surface)',
      }}
    >
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '9px 12px',
          border: 'none',
          background: 'var(--accent-soft)',
          color: 'var(--accent-ink)',
          font: '600 12px var(--font-heading)',
          cursor: 'pointer',
          textAlign: 'left',
        }}
      >
        <span
          style={{
            display: 'inline-flex',
            transform: open ? 'rotate(90deg)' : 'none',
            transition: 'transform .12s',
          }}
        >
          <Icon name="chevron" size={12} />
        </span>
        {items.length === 1 ? '1 thing to decide' : `${items.length} things to decide`}
        <div style={{ flex: 1 }} />
        <span className="meta" style={{ color: 'var(--accent-ink)' }}>
          {open ? 'hide' : 'show'}
        </span>
      </button>

      {open && (
        // Capped and scrollable: expanded with six proposals it must not push the board off
        // the screen. Its own scroll, so the page behind it never moves.
        <div className="scroll-y" style={{ maxHeight: '46vh', minHeight: 0, padding: 10 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {items.map((it) => {
              const expanded = openItem === it.id
              return (
                <div
                  key={it.id}
                  style={{ border: '1px solid var(--line)', background: 'var(--paper)' }}
                >
                  {/*
                    Summary first. The full brief used to render inline, unbounded, three cards
                    deep — a wall of text arriving the moment you pressed a button. Nothing is
                    hidden here; it is one click away instead of all at once.
                  */}
                  <button
                    onClick={() => setOpenItem(expanded ? null : it.id)}
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: 8,
                      width: '100%',
                      padding: '9px 10px',
                      border: 'none',
                      background: 'transparent',
                      cursor: 'pointer',
                      textAlign: 'left',
                    }}
                  >
                    <span
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 3,
                        flex: 1,
                        minWidth: 0,
                      }}
                    >
                      <span className="cap" style={{ color: 'var(--faint)' }}>
                        {KIND_LABEL[it.kind]}
                      </span>
                      <span style={{ font: '600 12.5px var(--font-heading)', lineHeight: 1.4 }}>
                        {it.title}
                      </span>
                      {it.summary && (
                        <span
                          className="meta ellip"
                          style={{ lineHeight: 1.5, whiteSpace: 'normal' }}
                        >
                          {it.summary}
                        </span>
                      )}
                    </span>
                    <span
                      className="meta"
                      style={{ color: 'var(--faint)', flex: 'none', paddingTop: 2 }}
                    >
                      {expanded ? 'less' : 'more'}
                    </span>
                  </button>

                  {expanded && (
                    <div style={{ padding: '0 10px 10px', borderTop: '1px solid var(--line-2)' }}>
                      {it.detail}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * Everything outstanding, in the order it should be dealt with.
 *
 * Ordered by how much is blocked behind it: a breakdown holds up every ticket inside it, a
 * route holds up one ticket, a draft holds up work that has not started, and a hire can wait
 * for any of them.
 */
export function buildTrayItems(input: {
  drafts: TicketDraft[]
  routes: Array<{ route: TicketRoute; ticket: Ticket }>
  epics: Epic[]
  hires: HireProposal[]
  render: {
    draft: (d: TicketDraft) => React.ReactNode
    route: (r: { route: TicketRoute; ticket: Ticket }) => React.ReactNode
    split: (e: Epic) => React.ReactNode
    hire: (h: HireProposal) => React.ReactNode
  }
}): TrayItem[] {
  const out: TrayItem[] = []

  for (const e of input.epics) {
    out.push({
      id: `split-${e.id}`,
      kind: 'split',
      title: e.title,
      summary: `${e.pieces.length} pieces — ${e.summary}`,
      detail: input.render.split(e),
    })
  }

  for (const r of input.routes) {
    out.push({
      id: `route-${r.route.id}`,
      kind: 'route',
      title: `#${r.ticket.number} ${r.ticket.title}`,
      summary: r.route.rationale,
      detail: input.render.route(r),
    })
  }

  for (const d of input.drafts) {
    out.push({
      id: `draft-${d.id}`,
      kind: 'draft',
      title: d.title,
      // First line only: a draft body can be several paragraphs and this is the peek.
      summary: d.body.split('\n').find((l) => l.trim().length > 0) ?? '',
      detail: input.render.draft(d),
    })
  }

  for (const h of input.hires) {
    out.push({
      id: `hire-${h.id}`,
      kind: 'hire',
      title: `Hire ${h.name}`,
      summary: h.why,
      detail: input.render.hire(h),
    })
  }

  return out
}
