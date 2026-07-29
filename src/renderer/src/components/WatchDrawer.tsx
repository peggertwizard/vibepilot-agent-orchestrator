import { useEffect, useRef, useState } from 'react'
import type { Agent, Ticket } from '@shared/types'
import { LIVE_STATUSES, formatTokens, prettyModel, tokenBreakdown, totalTokens } from '@shared/types'
import type { ActivityRow, LiveText } from '../stores/useProjectData'
import { Button } from './ui'
import { Icon } from './ui/Icon'
import { WorkingBars } from './ui/Blueprint'

/**
 * Watching one teammate work.
 *
 * Everything here was already crossing IPC — the adapter emits every event for every agent to
 * the global bus, and the coalescer forwards all of it. The reason you could never see any of
 * it is that the renderer held a single live slot keyed by whoever spoke last, so the Pilot
 * and a teammate overwrote each other.
 *
 * One thing genuinely cannot be shown: **their thinking text**. `thinking_delta` carries an
 * empty string on the wire — verified on Opus and Sonnet against a run with 43 thinking
 * blocks. So this shows *that* it is thinking, and never pretends to show what about.
 */
export function WatchDrawer({
  agent,
  ticket,
  rows,
  live,
  projectId,
  onClose,
}: {
  agent: Agent
  ticket: Ticket | null
  rows: ActivityRow[]
  live: LiveText | null
  projectId: string
  onClose: () => void
}) {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const running = LIVE_STATUSES.includes(agent.status)

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [rows.length, live?.text])

  /**
   * Talk to them, not about them.
   *
   * If you can see Jim reading the wrong file, the useful thing is to tell Jim — not to tell
   * the Pilot to tell Jim. `message_agent` already delivers into a live process's stdin with
   * its context intact; it was simply Pilot-only, with no human entry point.
   */
  const send = async (): Promise<void> => {
    const body = text.trim()
    if (!body || sending || !running) return
    setSending(true)
    try {
      await window.vibepilot.agents.message(projectId, agent.id, body)
      setText('')
    } finally {
      setSending(false)
    }
  }

  return (
    <aside
      style={{
        position: 'absolute',
        top: 0,
        right: 0,
        bottom: 0,
        width: 460,
        maxWidth: '90vw',
        zIndex: 30,
        background: 'var(--surface)',
        borderLeft: '1px solid var(--line)',
        boxShadow: 'var(--shadow-lg)',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <header
        style={{
          flex: 'none',
          padding: '11px 13px',
          borderBottom: '1px solid var(--line)',
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {running && <WorkingBars style={{ color: 'var(--accent)', height: 8 }} />}
          <span style={{ font: '600 14px var(--font-heading)' }}>{agent.name}</span>
          <span className="meta">{prettyModel(agent.resolvedModel, agent.model)}</span>
          {ticket && <span className="meta tnum">#{ticket.number}</span>}
          <div style={{ flex: 1 }} />
          {totalTokens(agent) > 0 && (
            <span className="meta tnum" title={tokenBreakdown(agent)}>
              {formatTokens(totalTokens(agent))} tok
            </span>
          )}
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              display: 'inline-flex',
            }}
          >
            <Icon name="close" size={13} color="var(--muted)" />
          </button>
        </div>
        {agent.worktreePath && (
          <button
            onClick={() => void window.vibepilot.system.revealInExplorer(agent.worktreePath!)}
            title={agent.worktreePath}
            className="ellip mono"
            style={{
              border: 'none',
              background: 'transparent',
              padding: 0,
              textAlign: 'left',
              fontSize: 10.5,
              color: 'var(--faint)',
              cursor: 'pointer',
              textDecoration: 'underline',
            }}
          >
            {agent.worktreePath}
          </button>
        )}
      </header>

      <div ref={scrollRef} className="scroll-y" style={{ flex: 1, padding: '10px 13px' }}>
        {rows.length === 0 && !live ? (
          <div style={{ fontSize: 12, color: 'var(--faint)', lineHeight: 1.6, paddingTop: 8 }}>
            Nothing yet. This fills up as they work, and it is kept only while the app is open.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            {rows.map((r) => (
              <Row key={r.id} row={r} />
            ))}
            {live?.text && (
              <div style={{ fontSize: 12, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
                {live.text}
              </div>
            )}
            {live?.compacting && (
              <div className="meta" style={{ color: 'var(--accent)' }}>
                summarising the conversation to make room… this takes a few minutes
              </div>
            )}
            {live?.thinking && !live.compacting && (
              <div className="meta" style={{ color: 'var(--faint)', fontStyle: 'italic' }}>
                thinking…
              </div>
            )}
            {live?.toolLine && (
              <div className="meta mono" style={{ color: 'var(--accent)' }}>
                {live.toolLine}…
              </div>
            )}
          </div>
        )}
      </div>

      <div style={{ flex: 'none', borderTop: '1px solid var(--line)', padding: 10 }}>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void send()
            }
          }}
          disabled={!running}
          placeholder={
            running
              ? `Say something to ${agent.name}…`
              : `${agent.name} isn't running — say it on the ticket instead.`
          }
          rows={2}
          style={{
            width: '100%',
            resize: 'none',
            border: '1px solid var(--line)',
            background: running ? 'var(--paper)' : 'transparent',
            color: 'var(--ink)',
            font: 'inherit',
            fontSize: 12,
            lineHeight: 1.6,
            padding: 7,
            outline: 'none',
          }}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
          <span className="meta" style={{ color: 'var(--faint)', flex: 1, lineHeight: 1.45 }}>
            Goes straight to {agent.name}, not through the Pilot. The Pilot is told you said
            something, so you are not both steering.
          </span>
          <Button
            kind="primary"
            height={26}
            disabled={!running || sending || !text.trim()}
            onClick={() => void send()}
          >
            Send
          </Button>
        </div>
      </div>
    </aside>
  )
}

function Row({ row }: { row: ActivityRow }) {
  const [open, setOpen] = useState(false)

  if (row.kind === 'lifecycle') {
    return (
      <div
        className="meta"
        style={{ color: row.isError ? 'var(--danger)' : 'var(--faint)', paddingTop: 2 }}
      >
        — {row.label}
        {row.detail ? `: ${row.detail}` : ''}
      </div>
    )
  }

  if (row.kind === 'text') {
    return (
      <div
        className="selectable"
        style={{
          fontSize: 12,
          lineHeight: 1.6,
          whiteSpace: 'pre-wrap',
          color: row.fromUser ? 'var(--accent-ink)' : 'var(--ink)',
          ...(row.fromUser
            ? { borderLeft: '2px solid var(--accent)', paddingLeft: 8 }
            : {}),
        }}
      >
        {row.detail}
      </div>
    )
  }

  return (
    <div style={{ border: '1px solid var(--line-2)', background: 'var(--paper)' }}>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          width: '100%',
          textAlign: 'left',
          border: 'none',
          background: 'transparent',
          padding: '5px 7px',
          cursor: 'pointer',
        }}
      >
        <Icon name="chevron" size={11} color="var(--faint)" style={{ transform: open ? 'rotate(90deg)' : undefined }} />
        <span className="mono" style={{ fontSize: 11, color: row.isError ? 'var(--danger)' : 'var(--ink-2)' }}>
          {row.label}
        </span>
        <div style={{ flex: 1 }} />
        {row.durationMs != null && (
          <span className="meta tnum" style={{ color: 'var(--faint)' }}>
            {row.durationMs < 1000 ? `${row.durationMs}ms` : `${(row.durationMs / 1000).toFixed(1)}s`}
          </span>
        )}
      </button>
      {open && (
        <div style={{ padding: '0 7px 7px', display: 'flex', flexDirection: 'column', gap: 6 }}>
          {row.detail && <Pre label="in" body={row.detail} />}
          {row.output && <Pre label="out" body={row.output} />}
        </div>
      )}
    </div>
  )
}

function Pre({ label, body }: { label: string; body: string }) {
  return (
    <div>
      <div className="cap" style={{ marginBottom: 3 }}>
        {label}
      </div>
      <pre
        className="selectable mono"
        style={{
          margin: 0,
          fontSize: 10.5,
          lineHeight: 1.55,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          color: 'var(--muted)',
          maxHeight: 240,
          overflowY: 'auto',
        }}
      >
        {body}
      </pre>
    </div>
  )
}
