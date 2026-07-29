import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  Agent,
  Attachment,
  Message,
  Project,
  Comm,
  Question,
  Ticket,
  TicketDraft,
  TicketRoute,
  ToolSummary,
} from '@shared/types'
import {
  EFFORT_OPTIONS,
  MODEL_OPTIONS,
  effortDefaultFor,
  formatTokens,
  isValidModel,
  modelLabel,
  prettyModel,
  totalTokens,
} from '@shared/types'
import { Avatar, Button, Empty, Input, Tag } from '../components/ui'
import { Blueprint, NeedsYouDot, WorkingBars } from '../components/ui/Blueprint'
import { Icon } from '../components/ui/Icon'
import { Markdown } from '../components/ui/Markdown'
import type { LiveText } from '../stores/useProjectData'
import { useResolvedModels, type ResolvedModels } from '../stores/useResolvedModels'

export function Messages({
  project,
  messages,
  drafts,
  questions,
  agents,
  tickets,
  routes,
  comms,
  live,
  model,
  onModelChange,
  draft,
  onDraftChange,
  attachments,
  onAttachmentsChange,
}: {
  project: Project
  messages: Message[]
  drafts: TicketDraft[]
  questions: Question[]
  agents: Agent[]
  tickets: Ticket[]
  routes: TicketRoute[]
  comms: Comm[]
  live: LiveText | null
  model: string
  onModelChange: (m: string) => void
  /** Held by CentrePane: this pane unmounts on every tab switch. */
  draft: string
  onDraftChange: (v: string) => void
  attachments: Attachment[]
  onAttachmentsChange: (v: Attachment[]) => void
}) {
  const [sending, setSending] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState(0)
  const pilot = agents.find((a) => a.isPilot) ?? null
  const resolved = useResolvedModels(agents)

  /** The Pilot is doing something, whether or not it has produced a single token yet. */
  const busyPilot = pilot ? ['starting', 'thinking', 'working'].includes(pilot.status) : false
  const busy = sending || busyPilot

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages.length, live?.text, drafts.length, questions.length])

  const send = async () => {
    const body = draft.trim()
    if (!body || sending) return
    const files = attachments
    onDraftChange('')
    onAttachmentsChange([])
    setSending(true)
    try {
      await window.vibepilot.messages.send(project.id, body, model, files)
    } catch {
      // Put it back rather than losing what they wrote.
      onDraftChange(body)
      onAttachmentsChange(files)
    } finally {
      setSending(false)
    }
  }

  /**
   * One timeline, in order.
   *
   * Team chatter appears here as a single collapsed line rather than in its own tab. The
   * objection to merging it was that Messages is good precisely because everything in it is
   * from you or for you — filling it with traffic you never need to read would destroy that.
   * A quiet one-liner that expands keeps both: one place, no firehose.
   */
  const timeline = [
    ...messages.map((m) => ({ kind: 'message' as const, id: m.id, at: m.createdAt, message: m })),
    ...comms.map((c) => ({ kind: 'comm' as const, id: c.id, at: c.createdAt, comm: c })),
  ].sort((a, b) => a.at - b.at)

  const empty = messages.length === 0 && comms.length === 0 && !live


  return (
    <div
      style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, position: 'relative' }}
      /*
       * The whole pane accepts a drop, not a small zone inside it.
       *
       * A target you have to aim at is worse than the Attach button it was meant to improve on.
       * `dragging` is counted rather than toggled: dragging over a child fires dragleave on the
       * parent, so a boolean flickers the overlay off and on as the pointer crosses each row.
       */
      onDragEnter={(e) => {
        if (e.dataTransfer.types.includes('Files')) setDragging((n) => n + 1)
      }}
      onDragLeave={() => setDragging((n) => Math.max(0, n - 1))}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) e.preventDefault()
      }}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(0)
        const paths = [...e.dataTransfer.files]
          .map((f) => window.vibepilot.pathForFile(f))
          .filter((p): p is string => !!p)
        if (paths.length) {
          void window.vibepilot.messages.attachPaths(paths).then((picked) => {
            if (picked.length) onAttachmentsChange([...attachments, ...picked].slice(0, 10))
          })
        }
      }}
    >
      {dragging > 0 && (
        <div
          style={{
            position: 'absolute',
            inset: 8,
            zIndex: 30,
            pointerEvents: 'none',
            border: '2px dashed var(--accent)',
            background: 'var(--accent-soft)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            font: '500 13px var(--font-heading)',
            color: 'var(--accent-ink)',
          }}
        >
          Drop to attach
        </div>
      )}
      <div ref={scrollRef} className="scroll-y" style={{ flex: 1, padding: '18px 20px 8px' }}>
        <div
          style={{
            maxWidth: 720,
            margin: '0 auto',
            display: 'flex',
            flexDirection: 'column',
            gap: 20,
          }}
        >
          {empty && project.bootstrappedAt === null ? (
            <FirstRunOffer project={project} />
          ) : empty ? (
            <Empty
              title="Say something to the Pilot"
              hint="Describe what you want done. It reads the repo, proposes tickets for you to accept, and hands work to teammates in their own worktrees. Nothing reaches your main branch until you merge it."
            />
          ) : (
            <>
              {timeline.map((row) =>
                row.kind === 'message' ? (
                  <MessageRow key={row.id} message={row.message} agents={agents} />
                ) : (
                  <CommRow key={row.id} comm={row.comm} agents={agents} />
                ),
              )}
              {/*
                The Pilot appears as soon as it is doing anything at all.

                This waited for the live buffer to have something in it — text, a thinking
                marker, a tool line — and none of those exist until the process is up and
                streaming. On a cold start that is ten seconds after you pressed Enter, during
                which the app showed your message and then, apparently, nothing. The status on
                the agent row is true much earlier, so the row is driven by that and the buffer
                fills it in when it arrives.
              */}
              {(busyPilot ||
                (live && (live.text || live.thinking || live.toolLine || live.compacting))) && (
                <LiveRow live={live} pilot={pilot} />
              )}
            </>
          )}

          {questions.map((q) => (
            <QuestionCard key={q.id} q={q} projectId={project.id} agents={agents} />
          ))}

          {/*
            Drafts and route proposals used to render here, inline in the stream, so they
            scrolled away and the Board never showed them. They live in the ProposalTray now —
            one surface over every tab. See components/ProposalTray.tsx.
          */}
        </div>
      </div>

      <Composer
        text={draft}
        setText={onDraftChange}
        attachments={attachments}
        onAttachmentsChange={onAttachmentsChange}
        onSend={send}
        busy={busy}
        model={model}
        resolved={resolved}
        onModelChange={onModelChange}
        onStop={() => void window.vibepilot.messages.stop(project.id)}
        pilot={pilot}
        projectId={project.id}
      />
    </div>
  )
}

/**
 * The first-run offer.
 *
 * The repo scan used to fire automatically the instant you picked a folder — spending a
 * model turn on the user's account with no warning, and streaming its output into the chat
 * as if a Pilot that did not yet exist were talking. Now it is a button that says what it
 * will do and what it costs, and nothing happens until it is pressed.
 */
function FirstRunOffer({ project }: { project: Project }) {
  const [state, setState] = useState<'idle' | 'scanning' | 'done'>('idle')

  if (state === 'done') {
    return (
      <Empty
        title="Say something to the Pilot"
        hint="Describe what you want done. It reads the repo, proposes tickets for you to accept, and hands work to teammates in their own worktrees. Nothing reaches your main branch until you merge it."
      />
    )
  }

  return (
    <Blueprint
      style={{
        border: '1px solid var(--accent)',
        background: 'var(--surface)',
        padding: '16px 18px',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
        <Avatar initials="PI" seed="pilot" size={24} isPilot />
        <span style={{ font: '600 14px var(--font-heading)' }}>
          Shall I read {project.name} first?
        </span>
      </div>
      <div style={{ fontSize: 12.5, lineHeight: 1.6, color: 'var(--ink-2)' }}>
        I&rsquo;ll look around the repo — languages, framework, tests, whether there&rsquo;s a
        UI — and suggest a starting team, each with a reason. Nobody is hired until you
        approve them.
      </div>
      <div style={{ fontSize: 12, lineHeight: 1.6, color: 'var(--muted)' }}>
        This spends <strong>one short Haiku turn</strong> on your Claude subscription. You can
        skip it and build the team yourself on the Team tab.
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 2 }}>
        <Button
          kind="primary"
          height={28}
          disabled={state === 'scanning'}
          onClick={() => {
            setState('scanning')
            void window.vibepilot.projects
              .bootstrap(project.id)
              .then(() => setState('done'))
              .catch(() => setState('idle'))
          }}
        >
          {state === 'scanning' ? 'Reading the repo…' : 'Read the repo'}
        </Button>
        <Button
          height={28}
          disabled={state === 'scanning'}
          onClick={() => {
            void window.vibepilot.projects.bootstrapSkip(project.id)
            setState('done')
          }}
        >
          Not now
        </Button>
        {state === 'scanning' && <WorkingBars style={{ color: 'var(--accent)', height: 9 }} />}
      </div>
    </Blueprint>
  )
}

/**
 * Team chatter, as one quiet line.
 *
 * You never have to read this — that is the point. It sits in order so you can see *when* the
 * team talked relative to everything else, and expands if you want to know what was said. The
 * full exchange also lives in the watch drawer next to the teammate it belongs to.
 *
 * A `blocker` shoutout breaks the rule and renders in full: that severity exists precisely to
 * mean "this one you do need to see".
 */
function CommRow({ comm, agents }: { comm: Comm; agents: Agent[] }) {
  const [open, setOpen] = useState(comm.severity === 'blocker')
  const from = agents.find((a) => a.id === comm.fromAgentId)?.name ?? 'someone'
  const to = agents.find((a) => a.id === comm.toAgentId)?.name
  const blocker = comm.severity === 'blocker'

  const first = comm.body.split(/\r?\n/)[0] ?? ''
  const gist = first.length > 70 ? `${first.slice(0, 70)}…` : first

  return (
    <div
      style={{
        borderLeft: `2px solid ${blocker ? 'var(--danger)' : 'var(--line)'}`,
        paddingLeft: 9,
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
      }}
    >
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          border: 'none',
          background: 'transparent',
          padding: 0,
          textAlign: 'left',
          cursor: 'pointer',
          color: blocker ? 'var(--danger)' : 'var(--faint)',
          font: '400 11px var(--font-heading)',
        }}
      >
        <span aria-hidden>⇄</span>
        <span>
          {from} {to ? `→ ${to}` : '→ everyone'}
        </span>
        {!open && <span style={{ color: 'var(--faint)' }}>· {gist}</span>}
        {blocker && <span className="cap" style={{ color: 'var(--danger)' }}>blocker</span>}
      </button>
      {open && (
        <div
          className="selectable"
          style={{
            fontSize: 12,
            lineHeight: 1.6,
            color: 'var(--muted)',
            whiteSpace: 'pre-wrap',
          }}
        >
          {comm.body}
        </div>
      )}
    </div>
  )
}

/* ── one persisted message ─────────────────────────────────────────────────── */

function MessageRow({ message, agents }: { message: Message; agents: Agent[] }) {
  const agent = agents.find((a) => a.id === message.agentId) ?? null

  if (message.authorType === 'user') {
    return (
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <div
          className="selectable"
          style={{
            maxWidth: '78%',
            background: 'var(--paper)',
            border: '1px solid var(--line)',
            borderRadius: 0,
            padding: '10px 13px',
            fontSize: 13.5,
            lineHeight: 1.6,
            whiteSpace: 'pre-wrap',
          }}
        >
          {message.body}
          {/*
            What you attached, shown back to you.

            These were stored on the message and drawn nowhere, so a screenshot vanished from
            the transcript the instant it was sent: the Pilot could see it and you could not,
            which makes rereading a conversation about an image impossible.
          */}
          {message.attachments.length > 0 && (
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: 6,
                marginTop: message.body ? 8 : 0,
              }}
            >
              {message.attachments.map((a) => (
                <AttachmentPreview key={a.path} attachment={a} />
              ))}
            </div>
          )}
        </div>
      </div>
    )
  }

  if (message.authorType === 'system') {
    const isError = message.kind === 'error'
    return (
      <div
        className="selectable"
        style={{
          borderLeft: `2px solid ${isError ? 'var(--danger)' : 'var(--line)'}`,
          paddingLeft: 12,
          fontSize: 12,
          lineHeight: 1.6,
          color: isError ? 'var(--danger)' : 'var(--muted)',
        }}
      >
        <Markdown text={message.body} />
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Avatar
          initials={agent?.avatarInitials ?? 'PI'}
          seed={agent?.id ?? 'pilot'}
          size={24}
          isPilot={agent?.isPilot ?? true}
        />
        <span style={{ fontSize: 12.5, fontWeight: 600 }}>{agent?.name ?? 'Pilot'}</span>
        {agent && <Tag tone="neutral">{prettyModel(agent.resolvedModel, agent.model)}</Tag>}
        <span className="meta">{time(message.createdAt)}</span>
        {message.usage && (
          /*
           * Weighted, like every other token figure in the app.
           *
           * This one was still summing the four fields raw, so a six-step turn on a 110k
           * conversation read **740k tok** beside a four-paragraph reply — the same lie plan 08
           * killed everywhere else, surviving in the one place you look at most. The bulk of
           * that is cache read: the conversation re-sent on every API round trip, counted once
           * per trip. It is not 740k of anything.
           */
          <span
            className="meta tnum"
            title={
              `${message.usage.inputTokens.toLocaleString()} in · ` +
              `${message.usage.outputTokens.toLocaleString()} out · ` +
              `${message.usage.cacheCreationTokens.toLocaleString()} cache written · ` +
              `${message.usage.cacheReadTokens.toLocaleString()} cache read` +
              `\n\nThe whole turn — every tool call and sub-agent. Cache reads are the same ` +
              `conversation re-sent on each round trip, not distinct content, so they count ` +
              `for a tenth. Output counts for five.`
            }
          >
            {formatTokens(
              totalTokens({
                tokensIn: message.usage.inputTokens,
                tokensOut: message.usage.outputTokens,
                tokensCacheRead: message.usage.cacheReadTokens,
                tokensCacheWrite: message.usage.cacheCreationTokens,
              }),
            )}{' '}
            tok
          </span>
        )}
      </div>

      {message.toolSummaries.length > 0 && <ToolLog tools={message.toolSummaries} />}

      {message.body.trim() && (
        <Markdown
          text={message.body}
          style={{ fontSize: 13.5, lineHeight: 1.62, color: 'var(--ink-2)', textWrap: 'pretty' }}
        />
      )}
    </div>
  )
}

/* ── in-flight turn ────────────────────────────────────────────────────────── */

/**
 * The Pilot, mid-turn.
 *
 * `live` is null until the process is up and streaming, which on a cold start is several
 * seconds after you pressed Enter — so this also renders from the agent row alone, and says
 * what that row says. The one thing it must never do is appear with nothing in it: a bare
 * avatar and an animation is the same silence with more pixels.
 */
function LiveRow({ live, pilot }: { live: LiveText | null; pilot: Agent | null }) {
  const note = live?.compacting
    ? // Minutes of silence otherwise, at the moment you are most likely to kill it.
      'summarising the conversation to make room…'
    : (live?.toolLine?.toLowerCase() ??
      // Falls back to whatever the engine last said it was doing — "Waking up" while the
      // process starts, then the real status line once it is running.
      pilot?.statusLine?.toLowerCase() ??
      (pilot?.status === 'starting' ? 'waking up…' : 'thinking…'))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Avatar
          initials={pilot?.avatarInitials ?? 'PI'}
          seed={pilot?.id ?? 'pilot'}
          size={24}
          isPilot
        />
        <span style={{ fontSize: 12.5, fontWeight: 600 }}>{pilot?.name ?? 'Pilot'}</span>
        <WorkingBars style={{ color: 'var(--accent)', height: 9 }} />
        <span
          className="meta"
          style={{ color: live?.compacting ? 'var(--accent)' : undefined }}
        >
          {note}
        </span>
      </div>
      {live?.text && (
        <Markdown
          text={live.text}
          style={{ fontSize: 13.5, lineHeight: 1.62, color: 'var(--ink-2)' }}
        />
      )}
    </div>
  )
}

/* ── collapsible tool log ──────────────────────────────────────────────────── */

function ToolLog({ tools }: { tools: ToolSummary[] }) {
  const [open, setOpen] = useState(false)
  const total = useMemo(
    () => tools.reduce((n, t) => n + (t.durationMs ?? 0), 0),
    [tools],
  )
  // Layer three: a builder can spawn a sub-agent for a bounded check inside its own session.
  // Those steps are its work, not a separate teammate's, so they indent rather than listing
  // flat — otherwise a Builder that ran two checks looks like three agents.
  const subagentSteps = useMemo(() => tools.filter((t) => t.subagentOf).length, [tools])
  return (
    <div>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 7,
          height: 29,
          padding: '0 10px',
          border: '1px solid var(--line)',
          borderRadius: 'var(--radius-md)',
          background: 'var(--paper)',
          color: 'var(--muted)',
          fontSize: 11,
        }}
        onMouseEnter={(e) => (e.currentTarget.style.borderColor = 'var(--color-accent-400)')}
        onMouseLeave={(e) => (e.currentTarget.style.borderColor = 'var(--line)')}
      >
        <Icon
          name="chevron"
          size={12}
          style={{ transform: `rotate(${open ? 90 : 0}deg)`, transition: 'transform .12s' }}
        />
        {tools.length} step{tools.length === 1 ? '' : 's'}
        {subagentSteps > 0 && (
          <span className="tnum" title="Steps run by a sub-agent inside this one's session">
            {' '}
            · {subagentSteps} delegated
          </span>
        )}
        {total > 0 && <span className="tnum"> · {(total / 1000).toFixed(1)}s</span>}
      </button>

      {open && (
        <div
          className="scroll-y mono"
          style={{
            marginTop: 6,
            border: '1px solid var(--line)',
            borderRadius: 'var(--radius-md)',
            background: 'var(--color-neutral-100)',
            padding: '9px 11px',
            maxHeight: 190,
            color: 'var(--muted)',
          }}
        >
          {tools.map((t) => (
            <ToolStep key={t.toolUseId} tool={t} />
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * One step in the tool log, expandable to what it actually did.
 *
 * The summary line answers "what happened"; the expansion answers "what exactly", which is
 * the question you have when something went wrong. The input and output are capped by the
 * translator — head AND tail, so a failure message at the end of a long output survives.
 */
function ToolStep({ tool }: { tool: ToolSummary }) {
  const [open, setOpen] = useState(false)
  const hasDetail = Boolean(tool.input || tool.output)

  return (
    <div
      style={{
        paddingLeft: tool.subagentOf ? 14 : 0,
        borderLeft: tool.subagentOf ? '1px solid var(--line)' : undefined,
        marginLeft: tool.subagentOf ? 3 : 0,
      }}
    >
      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
        <span style={{ color: tool.isError ? 'var(--danger)' : 'var(--ok)', flex: 'none' }}>
          {tool.isError ? '×' : '·'}
        </span>
        {hasDetail ? (
          <button
            onClick={() => setOpen((o) => !o)}
            title="Show what this step actually did"
            style={{
              flex: 1,
              textAlign: 'left',
              border: 'none',
              background: 'transparent',
              padding: 0,
              font: 'inherit',
              color: 'inherit',
              cursor: 'pointer',
            }}
          >
            <span style={{ color: 'var(--faint)', marginRight: 5 }}>{open ? '▾' : '▸'}</span>
            {tool.summary}
          </button>
        ) : (
          <span style={{ flex: 1 }}>{tool.summary}</span>
        )}
        {tool.durationMs != null && (
          <span className="tnum" style={{ color: 'var(--faint)', flex: 'none' }}>
            {tool.durationMs}ms
          </span>
        )}
      </div>

      {open && (
        <div style={{ margin: '4px 0 8px 16px', display: 'flex', flexDirection: 'column', gap: 5 }}>
          {tool.input && <Detail label={tool.name} body={tool.input} />}
          {tool.output && <Detail label="result" body={tool.output} tone={tool.isError ? 'error' : undefined} />}
          {tool.truncated && (
            <span style={{ color: 'var(--faint)', fontSize: 10.5 }}>
              Long output — the middle was elided. The start and end are shown in full.
            </span>
          )}
        </div>
      )}
    </div>
  )
}

function Detail({ label, body, tone }: { label: string; body: string; tone?: 'error' }) {
  return (
    <div>
      <div className="cap" style={{ marginBottom: 2, color: 'var(--faint)' }}>
        {label}
      </div>
      {/* Its own scroll box, so an expanded step never makes the message column scroll. */}
      <pre
        style={{
          margin: 0,
          padding: '6px 8px',
          background: 'var(--surface)',
          border: `1px solid ${tone === 'error' ? 'var(--danger)' : 'var(--line-2)'}`,
          color: 'var(--ink-2)',
          fontSize: 11,
          lineHeight: 1.5,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          maxHeight: 240,
          overflow: 'auto',
        }}
      >
        {body}
      </pre>
    </div>
  )
}

/* ── a question from an agent ──────────────────────────────────────────────── */

export function QuestionCard({
  q,
  projectId,
  agents,
}: {
  q: Question
  projectId: string
  agents: Agent[]
}) {
  const [free, setFree] = useState('')
  const [sent, setSent] = useState(false)
  const asker = agents.find((a) => a.id === q.agentId)
  const pilot = agents.find((a) => a.isPilot)

  const answer = async (a: string) => {
    if (!a.trim() || sent) return
    setSent(true)
    await window.vibepilot.questions.answer(projectId, q.id, a)
  }

  /*
   * Hand it over without giving it up.
   *
   * The card stays fully interactive after this — no disabled state, no spinner that owns the
   * question. You can still answer it yourself at any moment, and whichever of you gets there
   * first wins. That is why there is no take-it-back button: there is nothing to take back.
   */
  const askPilot = async () => {
    await window.vibepilot.questions.askPilot(projectId, q.id)
  }

  return (
    <Blueprint
      style={{
        border: '1px solid var(--accent)',
        background: 'var(--surface)',
        boxShadow: 'var(--shadow-sm)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '9px 13px',
          background: 'var(--accent-soft)',
          borderBottom: '1px solid color-mix(in oklab, var(--accent) 22%, white)',
        }}
      >
        <NeedsYouDot />
        <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--accent-ink)' }}>
          {asker?.name ?? 'An agent'} needs an answer
        </span>
        <div style={{ flex: 1 }} />
        {asker && <span className="meta">{asker.role}</span>}
      </div>

      <div style={{ padding: '12px 13px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div className="selectable" style={{ fontSize: 13, fontWeight: 500, lineHeight: 1.5 }}>
          {q.question}
        </div>
        {q.context && (
          <div
            className="selectable"
            style={{ font: '400 11px var(--font-heading)', color: 'var(--muted)', lineHeight: 1.6 }}
          >
            {q.context}
          </div>
        )}

        {q.choices.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {q.choices.map((c) => (
              <Button key={c} height={27} disabled={sent} onClick={() => void answer(c)}>
                {c}
              </Button>
            ))}
          </div>
        )}

        <div style={{ display: 'flex', gap: 6 }}>
          <Input
            value={free}
            onChange={setFree}
            height={28}
            placeholder={q.choices.length ? 'or say something else…' : 'your answer'}
            onEnter={() => void answer(free)}
          />
          <Button kind="primary" height={28} disabled={sent || !free.trim()} onClick={() => void answer(free)}>
            Send
          </Button>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {q.pilotAskedAt ? (
            <span className="meta" style={{ color: 'var(--muted)' }}>
              With the {pilot?.name ?? 'Pilot'} — you can still answer it yourself.
            </span>
          ) : (
            <button
              onClick={() => void askPilot()}
              disabled={sent}
              style={{
                border: 'none',
                background: 'transparent',
                padding: 0,
                color: sent ? 'var(--faint)' : 'var(--muted)',
                font: '400 11px var(--font-heading)',
                textDecoration: 'underline',
                cursor: sent ? 'default' : 'pointer',
              }}
            >
              Let the {pilot?.name ?? 'Pilot'} work this one out
            </button>
          )}
        </div>
      </div>
    </Blueprint>
  )
}

/* ── a proposed ticket ─────────────────────────────────────────────────────── */

export function DraftCard({ draft, projectId }: { draft: TicketDraft; projectId: string }) {
  const [title, setTitle] = useState(draft.title)
  const [busy, setBusy] = useState(false)

  const accept = async () => {
    setBusy(true)
    if (title !== draft.title) {
      await window.vibepilot.drafts.update(projectId, draft.id, { title })
    }
    await window.vibepilot.drafts.accept(projectId, draft.id)
  }
  const reject = async () => {
    setBusy(true)
    await window.vibepilot.drafts.reject(projectId, draft.id)
  }

  return (
    <Blueprint style={{ border: '1px solid var(--line)', background: 'var(--surface)' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 8,
          padding: '9px 13px',
          borderBottom: '1px solid var(--line-2)',
        }}
      >
        <span
          style={{
            font: '400 9.5px var(--font-heading)',
            letterSpacing: '.11em',
            textTransform: 'uppercase',
            color: 'var(--ink-2)',
          }}
        >
          Proposed ticket
        </span>
        <span className="meta" style={{ flex: 1 }}>
          not created yet — you decide
        </span>
        {draft.needsPlanning && <Tag tone="accent">needs planning</Tag>}
      </div>

      <div style={{ padding: '11px 13px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        <Input value={title} onChange={setTitle} height={31} />

        {draft.body.trim() && (
          <div
            className="selectable"
            style={{
              borderLeft: '2px solid var(--line)',
              paddingLeft: 12,
              fontSize: 12.5,
              lineHeight: 1.6,
              color: 'var(--ink-2)',
              whiteSpace: 'pre-wrap',
              maxHeight: 220,
              overflowY: 'auto',
            }}
          >
            {draft.body}
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <Button kind="primary" height={30} disabled={busy} onClick={() => void accept()}>
            Create ticket
          </Button>
          <Button height={30} disabled={busy} onClick={() => void reject()}>
            Discard
          </Button>
          <div style={{ flex: 1 }} />
          {draft.sizeNote && <span className="meta">{draft.sizeNote}</span>}
        </div>
      </div>
    </Blueprint>
  )
}

/* ── composer ──────────────────────────────────────────────────────────────── */

function Composer({
  text,
  setText,
  attachments,
  onAttachmentsChange,
  onSend,
  busy,
  model,
  resolved,
  onModelChange,
  onStop,
  pilot,
  projectId,
}: {
  text: string
  setText: (v: string) => void
  attachments: Attachment[]
  onAttachmentsChange: (v: Attachment[]) => void
  onSend: () => void
  busy: boolean
  model: string
  resolved: ResolvedModels
  onModelChange: (m: string) => void
  onStop: () => void
  pilot: Agent | null
  projectId: string
}) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pin, setPin] = useState('')
  const [commands, setCommands] = useState<Array<{ name: string; description: string }>>([])

  const add = (picked: Attachment[]): void => {
    if (picked.length) onAttachmentsChange([...attachments, ...picked].slice(0, 10))
  }

  /*
   * The `/` menu.
   *
   * An affordance over pass-through, not an implementation. vibePilot's argv sends whatever you
   * type straight to the CLI, so every one of these already worked — you just had to know it
   * existed. Interception would only drift from the CLI's own behaviour on its next update.
   */
  const slash = text.startsWith('/') && !text.includes('\n') ? text.slice(1).toLowerCase() : null
  useEffect(() => {
    if (slash === null) return
    // Read on each open: a skill added while the app is running should just appear.
    void window.vibepilot.messages.commands(projectId).then(setCommands)
  }, [slash === null, projectId])

  const menu = useMemo(() => {
    if (slash === null) return []
    const app = [
      {
        name: 'clear',
        description: 'Start a new session. Throws away everything the Pilot has learned.',
        group: 'vibePilot',
      },
      {
        name: 'compact',
        description: 'Summarise the conversation now, rather than waiting for the limit.',
        group: 'vibePilot',
      },
    ]
    const mine = commands.map((c) => ({ ...c, group: 'this project' }))
    return [...app, ...mine].filter((c) => c.name.toLowerCase().startsWith(slash)).slice(0, 8)
  }, [slash, commands])

  return (
    // Dropping is handled once, on the whole pane — see the wrapper in Messages. Repeating it
    // here would attach every dropped file twice, since the event bubbles.
    <div style={{ flex: 'none', padding: '0 20px 16px' }}>
      <div style={{ maxWidth: 720, margin: '0 auto' }}>
        <div
          style={{
            position: 'relative',
            border: '1px solid var(--line)',
            borderRadius: 0,
            background: 'var(--surface)',
            boxShadow: 'var(--shadow-sm)',
          }}
        >
          {menu.length > 0 && (
            <SlashMenu
              items={menu}
              onPick={(name) => setText(`/${name} `)}
            />
          )}
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onPaste={(e) => {
              // A screenshot has no path — it exists only in the clipboard. This is the one
              // case where the bytes legitimately come through the renderer.
              const file = [...e.clipboardData.items]
                .find((i) => i.kind === 'file' && i.type.startsWith('image/'))
                ?.getAsFile()
              if (!file) return
              e.preventDefault()
              void file.arrayBuffer().then((buf) => {
                let bin = ''
                const bytes = new Uint8Array(buf)
                for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!)
                const name = file.name || `pasted.${file.type.split('/')[1] ?? 'png'}`
                void window.vibepilot.messages
                  .attachData(name, btoa(bin))
                  .then((a) => add(a ? [a] : []))
              })
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && menu.length) {
                e.preventDefault()
                setText('')
                return
              }
              if (e.key === 'Tab' && menu.length) {
                e.preventDefault()
                setText(`/${menu[0]!.name} `)
                return
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                onSend()
              }
            }}
            placeholder="Tell the Pilot what you want done…"
            style={{
              width: '100%',
              minHeight: 56,
              maxHeight: 140,
              padding: '11px 12px 4px',
              border: 'none',
              outline: 'none',
              resize: 'none',
              background: 'transparent',
              color: 'var(--ink)',
              font: 'inherit',
              fontSize: 13.5,
              lineHeight: 1.55,
            }}
          />
          {attachments.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, padding: '0 10px 6px' }}>
              {attachments.map((a) => (
                <span
                  key={a.path}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 5,
                    border: '1px solid var(--line)',
                    background: 'var(--paper)',
                    padding: '2px 4px 2px 7px',
                    fontSize: 11,
                    color: 'var(--ink-2)',
                    maxWidth: 240,
                  }}
                >
                  <span className="ellip">{a.name}</span>
                  <span className="meta tnum" style={{ flex: 'none' }}>
                    {Math.max(1, Math.round(a.bytes / 1024))}k
                  </span>
                  <button
                    title="Remove"
                    onClick={() => onAttachmentsChange(attachments.filter((x) => x.path !== a.path))}
                    style={{
                      border: 'none',
                      background: 'transparent',
                      color: 'var(--faint)',
                      padding: '0 2px',
                      cursor: 'pointer',
                      lineHeight: 1,
                    }}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}

          <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '4px 8px 8px' }}>
            <div style={{ position: 'relative' }}>
              <button
                onClick={() => setPickerOpen((o) => !o)}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  height: 27,
                  padding: '0 9px',
                  border: '1px solid var(--line)',
                  borderRadius: 'var(--radius-md)',
                  background: 'var(--paper)',
                  font: '400 11px var(--font-heading)',
                  color: 'var(--ink-2)',
                }}
              >
                <span
                  style={{
                    width: 5,
                    height: 5,
                    borderRadius: 'var(--radius-sm)',
                    background: pilot?.status === 'idle' ? 'var(--ok)' : 'var(--accent)',
                  }}
                />
                {model ? modelLabel(model) : 'Pick a model'}
                {resolved[model] && (
                  <span className="meta" style={{ color: 'var(--faint)' }}>
                    {prettyModel(resolved[model])}
                  </span>
                )}
                <span style={{ color: 'var(--faint)', fontSize: 9 }}>▾</span>
              </button>

              {pickerOpen && (
                <div
                  style={{
                    position: 'absolute',
                    bottom: 32,
                    left: 0,
                    zIndex: 20,
                    width: 250,
                    border: '1px solid var(--line)',
                    background: 'var(--surface)',
                    boxShadow: 'var(--shadow-md)',
                    padding: 3,
                  }}
                >
                  {/* The Pilot is Claude-only: Codex cannot hold a persistent multi-turn
                      conversation, which is the one thing the Pilot exists to do. */}
                  {MODEL_OPTIONS.filter((m) => m.provider === 'claude').map((m) => (
                    <button
                      key={m.id}
                      onClick={() => {
                        onModelChange(m.id)
                        setPickerOpen(false)
                      }}
                      style={{
                        display: 'block',
                        width: '100%',
                        textAlign: 'left',
                        padding: '6px 8px',
                        border: 'none',
                        background: m.id === model ? 'var(--tint)' : 'transparent',
                        borderRadius: 'var(--radius-sm)',
                      }}
                    >
                      <span style={{ display: 'block', fontSize: 12, fontWeight: 500 }}>
                        {m.label}
                      </span>
                      <span className="meta" style={{ display: 'block' }}>
                        {/*
                          The exact model about to run, when the CLI has told us. This used to
                          fall back to a blurb about the tier — so the line under the name was
                          sometimes a version and sometimes a sales pitch, with nothing to say
                          which. Better blank than confidently decorative.
                        */}
                        {resolved[m.id] ?? ''}
                      </span>
                    </button>
                  ))}

                  {/*
                    An alias always means latest. This is how you hold the Pilot on a
                    specific version — to compare behaviour, or because a newer one changed
                    something you relied on.
                  */}
                  <div style={{ borderTop: '1px solid var(--line-2)', margin: '3px 0', padding: '6px 8px 2px' }}>
                    <div className="cap" style={{ marginBottom: 4 }}>
                      or pin a version
                    </div>
                    <input
                      value={pin}
                      onChange={(e) => setPin(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key !== 'Enter') return
                        const v = pin.trim()
                        if (!isValidModel(v)) return
                        onModelChange(v)
                        setPin('')
                        setPickerOpen(false)
                      }}
                      placeholder="claude-opus-4-8"
                      style={{
                        width: '100%',
                        height: 24,
                        padding: '0 6px',
                        border: `1px solid ${pin && !isValidModel(pin.trim()) ? 'var(--danger)' : 'var(--line)'}`,
                        background: 'var(--paper)',
                        color: 'var(--ink)',
                        font: 'inherit',
                        fontSize: 11.5,
                        outline: 'none',
                      }}
                    />
                    <div className="meta" style={{ marginTop: 3, color: 'var(--faint)' }}>
                      Enter to apply. Pinned models never move.
                    </div>
                  </div>

                  {/*
                    How hard the Pilot thinks. It orchestrates rather than solves, so medium is
                    the sensible default — but this is the one agent you talk to directly, and
                    a hard conversation deserves more than a routing decision does.
                  */}
                  <div style={{ borderTop: '1px solid var(--line-2)', margin: '3px 0', padding: '6px 8px 4px' }}>
                    <div className="cap" style={{ marginBottom: 4 }}>
                      how hard it thinks
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
                      {EFFORT_OPTIONS.map((o) => {
                        const active = (pilot?.effort ?? effortDefaultFor('pilot')) === o.id
                        return (
                          <button
                            key={o.id}
                            title={o.note}
                            onClick={() => {
                              if (pilot) void window.vibepilot.agents.update(projectId, pilot.id, { effort: o.id })
                            }}
                            style={{
                              border: `1px solid ${active ? 'var(--accent)' : 'var(--line)'}`,
                              background: active ? 'var(--color-accent-200)' : 'transparent',
                              color: active ? 'var(--ink)' : 'var(--faint)',
                              font: '400 10px var(--font-heading)',
                              padding: '3px 6px',
                              cursor: 'pointer',
                            }}
                          >
                            {o.label}
                          </button>
                        )
                      })}
                    </div>
                    <div className="meta" style={{ marginTop: 4, color: 'var(--faint)', lineHeight: 1.45 }}>
                      Applies to the Pilot&apos;s next turn. Teammates have their own, on the Team
                      tab.
                    </div>
                  </div>
                </div>
              )}
            </div>

            <button
              title="Attach files"
              onClick={() => void window.vibepilot.messages.attach().then(add)}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                height: 27,
                padding: '0 9px',
                border: '1px solid var(--line)',
                borderRadius: 'var(--radius-md)',
                background: 'var(--paper)',
                color: 'var(--ink-2)',
                font: '400 11px var(--font-heading)',
                cursor: 'pointer',
              }}
            >
              <Icon name="add" size={11} />
              Attach
            </button>

            <div style={{ flex: 1 }} />

            {busy ? (
              <Button height={27} onClick={onStop} title="Stops the process and loses this turn">
                <Icon name="halt" size={11} />
                Stop
              </Button>
            ) : (
              <Button kind="primary" height={27} disabled={!text.trim()} onClick={onSend}>
                Send
                <Icon name="return" size={11} />
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * What `/` offers.
 *
 * Two groups, and the distinction between them is the whole point. "vibePilot" are commands
 * the app has an opinion about — `/clear` and `/compact` change state the app tracks, so it
 * labels them and records what they did. "this project" is whatever the repo defines, listed
 * and passed through untouched. Anything not on the list still works; it just is not advertised.
 */
function SlashMenu({
  items,
  onPick,
}: {
  items: Array<{ name: string; description: string; group: string }>
  onPick: (name: string) => void
}) {
  let lastGroup = ''
  return (
    <div
      style={{
        position: 'absolute',
        bottom: 'calc(100% + 4px)',
        left: 0,
        right: 0,
        zIndex: 20,
        border: '1px solid var(--line)',
        background: 'var(--surface)',
        boxShadow: 'var(--shadow-md)',
        padding: 3,
        maxHeight: 260,
        overflowY: 'auto',
      }}
    >
      {items.map((c, i) => {
        const header = c.group !== lastGroup ? c.group : null
        lastGroup = c.group
        return (
          <div key={`${c.group}/${c.name}`}>
            {header && (
              <div className="cap" style={{ padding: '5px 8px 3px' }}>
                {header}
              </div>
            )}
            <button
              onClick={() => onPick(c.name)}
              style={{
                display: 'block',
                width: '100%',
                textAlign: 'left',
                padding: '5px 8px',
                border: 'none',
                background: i === 0 ? 'var(--tint)' : 'transparent',
                borderRadius: 'var(--radius-sm)',
                cursor: 'pointer',
              }}
            >
              <span className="mono" style={{ fontSize: 12, fontWeight: 500 }}>
                /{c.name}
              </span>
              {c.description && (
                <span className="meta ellip" style={{ display: 'block' }}>
                  {c.description}
                </span>
              )}
            </button>
          </div>
        )
      })}
      <div className="meta" style={{ padding: '4px 8px 3px', color: 'var(--faint)' }}>
        Tab to complete · anything else you type is passed to Claude as-is
      </div>
    </div>
  )
}

/* ── helpers ───────────────────────────────────────────────────────────────── */

function time(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

/**
 * One attachment, in the transcript.
 *
 * Images inline, because the point of attaching one is that it is looked at. Everything else
 * is a name — a PDF thumbnail would be a rendering project, and the filename is what you
 * recognise anyway.
 */
function AttachmentPreview({ attachment }: { attachment: Attachment }) {
  const [src, setSrc] = useState<string | null>(null)
  const isImage = attachment.mediaType.startsWith('image/')

  useEffect(() => {
    if (!isImage) return
    let alive = true
    void window.vibepilot.attachments.data(attachment.path).then((d) => {
      if (alive) setSrc(d)
    })
    return () => {
      alive = false
    }
  }, [attachment.path, isImage])

  if (isImage && src) {
    return (
      <img
        src={src}
        alt={attachment.name}
        title={attachment.name}
        onClick={() => void window.vibepilot.system.revealInExplorer(attachment.path)}
        style={{
          maxWidth: 220,
          maxHeight: 160,
          objectFit: 'cover',
          border: '1px solid var(--line)',
          cursor: 'pointer',
          display: 'block',
        }}
      />
    )
  }

  // Not an image, too large to inline, or gone from disk. Say what it was either way — a
  // silently missing attachment is how this looked before.
  return (
    <span
      title={attachment.path}
      onClick={() => void window.vibepilot.system.revealInExplorer(attachment.path)}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: '3px 7px',
        border: '1px solid var(--line)',
        background: 'var(--surface)',
        font: '400 11px var(--font-heading)',
        color: 'var(--muted)',
        cursor: 'pointer',
      }}
    >
      <Icon name="files" size={11} />
      {attachment.name}
    </span>
  )
}
