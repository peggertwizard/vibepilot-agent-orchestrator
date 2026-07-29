import { useMemo, useState } from 'react'
import {
  DndContext,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import type {
  Agent,
  Epic,
  EpicPiece,
  Finding,
  Lane,
  Project,
  StepKind,
  Ticket,
  TicketRoute,
} from '@shared/types'
import {
  LANES,
  LANE_LABEL,
  STEP_KINDS,
  STEP_LABEL,
  activeStep,
  epicColour,
  routeSummary,
} from '@shared/types'
import { Avatar, Button, Empty, Input, RouteMarker, SectionRule, Tag } from '../components/ui'
import { WorkingBars } from '../components/ui/Blueprint'
import { TicketDetail } from '../components/TicketDetail'

export function Board({
  project,
  tickets,
  routes,
  findings,
  epics,
  agents,
}: {
  project: Project
  tickets: Ticket[]
  routes: TicketRoute[]
  findings: Finding[]
  epics: Epic[]
  agents: Agent[]
}) {
  const [creating, setCreating] = useState(false)
  /*
   * Which ticket is open, if any.
   *
   * Panel state rather than a route: vibePilot has no routing today, and nothing needs a deep
   * link into a ticket yet. Easy to promote later if something does.
   *
   * A **panel, not a modal** — a modal blocks the board behind it, and the reason to open a
   * ticket is usually to compare it with the others.
   *
   * Declared here with the other hooks, ABOVE the empty-board early return. It sat below it at
   * first, so opening the board with tickets on it rendered one more hook than the empty board
   * had — "Rendered fewer hooks than expected", and a crash the moment you clicked a card.
   */
  const [openTicketId, setOpenTicketId] = useState<string | null>(null)
  const [showArchive, setShowArchive] = useState(false)
  /** Show only this epic's children. Null = the whole board. */
  const [isolated, setIsolated] = useState<string | null>(null)

  /**
   * A drag has to beat a click: every card has buttons on it, and without a distance
   * threshold a press on the archive button would start a drag instead of pressing it.
   */
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

  const onDragEnd = (e: DragEndEvent): void => {
    const lane = e.over?.id as Lane | undefined
    const ticketId = String(e.active.id)
    if (!lane) return
    const t = allLive.find((x) => x.id === ticketId)
    if (!t || t.lane === lane) return
    // Only the lane moves. The route owns the stage, and dropping a card into a column
    // is not a statement about which step it is on.
    void window.vibepilot.tickets.update(project.id, ticketId, { lane })
  }

  const allLive = useMemo(() => tickets.filter((t) => !t.archivedAt), [tickets])
  // Isolating narrows the board rather than opening a separate view: you still see the
  // pieces in their real lanes, which is the only way the board keeps telling the truth.
  const live = useMemo(
    () => (isolated ? allLive.filter((t) => t.epicId === isolated) : allLive),
    [allLive, isolated],
  )

  const proposedEpics = useMemo(() => epics.filter((e) => e.status === 'proposed'), [epics])
  const liveEpics = useMemo(() => epics.filter((e) => e.status !== 'proposed'), [epics])
  const epicById = useMemo(() => new Map(epics.map((e) => [e.id, e])), [epics])

  const findingsFor = useMemo(() => {
    const m = new Map<string, Finding[]>()
    for (const f of findings) {
      const arr = m.get(f.ticketId) ?? []
      arr.push(f)
      m.set(f.ticketId, arr)
    }
    return m
  }, [findings])

  const accepted = useMemo(
    () => new Map(routes.filter((r) => r.status === 'accepted').map((r) => [r.ticketId, r])),
    [routes],
  )
  const proposed = useMemo(
    () => new Map(routes.filter((r) => r.status === 'proposed').map((r) => [r.ticketId, r])),
    [routes],
  )

  /** Backlog respects the order the Pilot proposed; everything else stays by number. */
  const byLane = (lane: Lane): Ticket[] => {
    const list = live.filter((t) => t.lane === lane)
    if (lane !== 'backlog') return list
    return [...list].sort((a, b) => {
      if (a.backlogRank === b.backlogRank) return a.number - b.number
      if (a.backlogRank === null) return 1
      if (b.backlogRank === null) return -1
      return a.backlogRank - b.backlogRank
    })
  }

  const inProgress = byLane('in_progress')
  const awaitingRoute = live.filter((t) => proposed.has(t.id)).length
  // The honest ceiling. One person takes one ticket, so how much can run at once is how many
  // people you have — not a number in a settings box that enforced nothing.
  const teamSize = agents.filter((a) => !a.isPilot && a.isRoster).length

  /**
   * Sub-lanes come from what is actually being worked, not from a fixed list. A board with
   * only build work shows one lane; the moment something is under review, a Review lane
   * appears. v1 always drew Plan/Build/Verify whether or not anything was in them.
   */
  const liveStepKinds = useMemo(() => {
    const present = new Set<StepKind>()
    for (const t of inProgress) if (t.stage) present.add(t.stage)
    return STEP_KINDS.filter((k) => present.has(k))
  }, [inProgress])

  if (live.length === 0 && !creating) {
    return (
      <Empty
        title="No tickets yet"
        hint="Ask the Pilot for something and accept the draft it proposes, or add a ticket yourself."
        action={
          <Button kind="primary" height={30} onClick={() => setCreating(true)} style={{ marginTop: 4 }}>
            New ticket
          </Button>
        }
      />
    )
  }

  // A ticket archived while its panel was open should close it rather than render a stale copy.
  const openTicket = tickets.find((t) => t.id === openTicketId) ?? null

  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        position: 'relative',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '12px 20px',
          borderBottom: '1px solid var(--line-2)',
          flex: 'none',
        }}
      >
        <Button kind="primary" height={28} onClick={() => setCreating((c) => !c)}>
          + New ticket
        </Button>
        <span style={{ width: 1, height: 18, background: 'var(--line)' }} />
        {awaitingRoute > 0 && <Tag tone="accent">route to decide · {awaitingRoute}</Tag>}
        <div style={{ flex: 1 }} />
        <Button kind="ghost" height={26} onClick={() => setShowArchive((s) => !s)}>
          {showArchive ? 'Hide archive' : `Archive · ${tickets.length - live.length}`}
        </Button>
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '8px 20px',
          flex: 'none',
        }}
      >
        <span className="cap">Every ticket has its own route</span>
        <span className="meta" style={{ color: 'var(--faint)' }}>
          dots = its steps · filled = done · outlined = where it is · dashed = sent back
        </span>
      </div>

      {creating && <NewTicketForm projectId={project.id} onClose={() => setCreating(false)} />}

      {proposedEpics.map((e) => (
        <SplitProposal key={e.id} epic={e} projectId={project.id} />
      ))}

      {liveEpics.length > 0 && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 7,
            padding: '0 20px 10px',
            flex: 'none',
            flexWrap: 'wrap',
          }}
        >
          {liveEpics.map((e) => {
            const kids = allLive.filter((t) => t.epicId === e.id)
            const done = kids.filter((t) => t.lane === 'done').length
            const on = isolated === e.id
            return (
              <button
                key={e.id}
                onClick={() => setIsolated(on ? null : e.id)}
                title={on ? 'Show the whole board again' : `Show only ${e.title}`}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  border: `1px solid ${on ? 'var(--accent)' : 'var(--line)'}`,
                  background: on ? 'var(--color-accent-100)' : 'transparent',
                  padding: '3px 8px',
                  cursor: 'pointer',
                }}
              >
                <span
                  style={{
                    width: 3,
                    height: 12,
                    background: epicColour(e.colourIndex),
                    flex: 'none',
                  }}
                />
                <span style={{ fontSize: 11.5, color: 'var(--ink)' }}>{e.title}</span>
                <span className="meta tnum">
                  {done}/{kids.length}
                </span>
              </button>
            )
          })}
          {isolated && (
            <Button kind="ghost" height={22} onClick={() => setIsolated(null)}>
              Show everything
            </Button>
          )}
        </div>
      )}

      <div className="scroll-y" style={{ flex: 1, padding: '0 20px 20px', minHeight: 0 }}>
        <DndContext sensors={sensors} onDragEnd={onDragEnd}>
        <div style={{ display: 'flex', gap: 12, minWidth: 940, alignItems: 'flex-start' }}>
          {LANES.map((lane) =>
            lane === 'in_progress' ? (
              <LaneDrop
                key={lane}
                lane={lane}
                style={{
                  flex: 1.15,
                  border: '1px solid var(--line)',
                  background: 'var(--paper)',
                  padding: 9,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span className="cap">{LANE_LABEL[lane]}</span>
                  <span
                    className="meta tnum"
                    title={
                      `One person takes one ticket at a time, so the team size is the ceiling. ` +
                      `Hire someone to go faster.`
                    }
                  >
                    {inProgress.length} / {teamSize}
                  </span>
                  {inProgress.length > 0 && (
                    <WorkingBars style={{ color: 'var(--accent)', height: 8 }} />
                  )}
                </div>
                {liveStepKinds.map((kind) => {
                  const list = inProgress.filter((t) => t.stage === kind)
                  return (
                    <div key={kind} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <SectionRule label={STEP_LABEL[kind]} count={list.length} />
                      {list.map((t) => (
                        <TicketCard
                          key={t.id}
                          ticket={t}
                          route={accepted.get(t.id) ?? null}
                          proposal={proposed.get(t.id) ?? null}
                          findings={findingsFor.get(t.id) ?? []}
                      epic={t.epicId ? (epicById.get(t.epicId) ?? null) : null}
                          agents={agents}
                          projectId={project.id}
                          onOpen={() => setOpenTicketId(t.id)}
                        />
                      ))}
                    </div>
                  )
                })}
                {/* Assigned but not yet on a step — a worktree is being cut, or nobody is on it. */}
                {inProgress
                  .filter((t) => !t.stage)
                  .map((t) => (
                    <TicketCard
                      key={t.id}
                      ticket={t}
                      route={accepted.get(t.id) ?? null}
                      proposal={proposed.get(t.id) ?? null}
                      findings={findingsFor.get(t.id) ?? []}
                      epic={t.epicId ? (epicById.get(t.epicId) ?? null) : null}
                      agents={agents}
                      projectId={project.id}
                      onOpen={() => setOpenTicketId(t.id)}
                    />
                  ))}
              </LaneDrop>
            ) : (
              <LaneDrop
                key={lane}
                lane={lane}
                style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 7, minHeight: 60 }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '2px 0' }}>
                  <span className="cap">{LANE_LABEL[lane]}</span>
                  <span className="meta tnum">{byLane(lane).length}</span>
                </div>
                {byLane(lane).map((t) => (
                  <TicketCard
                    key={t.id}
                    ticket={t}
                    route={accepted.get(t.id) ?? null}
                    proposal={proposed.get(t.id) ?? null}
                    findings={findingsFor.get(t.id) ?? []}
                    epic={t.epicId ? (epicById.get(t.epicId) ?? null) : null}
                    agents={agents}
                    projectId={project.id}
                    onOpen={() => setOpenTicketId(t.id)}
                  />
                ))}
              </LaneDrop>
            ),
          )}
        </div>
        </DndContext>

        {showArchive && (
          <div style={{ marginTop: 22 }}>
            <SectionRule label="Archive" count={tickets.length - live.length} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
              {tickets
                .filter((t) => t.archivedAt)
                .map((t) => (
                  <TicketCard
                    key={t.id}
                    ticket={t}
                    route={accepted.get(t.id) ?? null}
                    proposal={null}
                    findings={[]}
                    epic={t.epicId ? (epicById.get(t.epicId) ?? null) : null}
                    agents={agents}
                    projectId={project.id}
                    dim
                    // Archived cards cannot be dragged, but reading one is exactly what a
                    // detail panel is for.
                    onOpen={() => setOpenTicketId(t.id)}
                  />
                ))}
            </div>
          </div>
        )}
      </div>

      {openTicket && (
        <TicketDetail
          ticketId={openTicket.id}
          projectId={project.id}
          agents={agents}
          baseBranch={project.defaultBaseBranch}
          onClose={() => setOpenTicketId(null)}
        />
      )}
    </div>
  )
}

function TicketCard({
  ticket,
  route,
  proposal,
  findings,
  epic,
  agents,
  projectId,
  dim,
  onOpen,
}: {
  ticket: Ticket
  route: TicketRoute | null
  proposal: TicketRoute | null
  findings: Finding[]
  epic: Epic | null
  agents: Agent[]
  projectId: string
  dim?: boolean
  /** Opens the detail panel. The card is a drag handle, so only the title is clickable. */
  onOpen?: () => void
}) {
  const [showFindings, setShowFindings] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const step = activeStep(route)
  const assignee =
    agents.find((a) => a.id === (step?.assigneeAgentId ?? ticket.assigneeAgentId)) ?? null
  const done = ticket.lane === 'done'
  const passes = step?.passes ?? 1

  // Archived cards are history; dragging one would imply it can move, and it cannot.
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: ticket.id,
    disabled: !!dim,
  })

  return (
    <div
      ref={dim ? undefined : setNodeRef}
      {...(dim ? {} : attributes)}
      {...(dim ? {} : listeners)}
      style={{
        border: `1px solid ${proposal ? 'var(--accent)' : 'var(--line)'}`,
        // The spine says "this is one piece of something larger" without costing a row.
        borderLeft: epic ? `2px solid ${epicColour(epic.colourIndex)}` : undefined,
        borderRadius: 0,
        background: done || dim ? 'var(--color-neutral-100)' : 'var(--surface)',
        padding: 'var(--cardpad)',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        opacity: isDragging ? 0.4 : dim ? 0.7 : 1,
        transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
        // The card follows the pointer, so it has to sit above its neighbours.
        zIndex: isDragging ? 10 : undefined,
        position: 'relative',
        cursor: dim ? 'default' : 'grab',
        touchAction: 'none',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 7 }}>
        <span className="meta tnum">#{ticket.number}</span>
        {epic && (
          <span className="meta" style={{ color: 'var(--faint)' }} title={epic.title}>
            {epic.shortLabel}
          </span>
        )}
        {ticket.dependsOn.length > 0 && (
          <span className="meta" style={{ color: 'var(--faint)' }} title="Waiting on these first">
            after {ticket.dependsOn.map((n) => `#${n}`).join(', ')}
          </span>
        )}
        {passes > 1 && <Tag tone="warn">pass {passes}</Tag>}
        {ticket.readyToMerge && <Tag tone="ok">ready</Tag>}
        <div style={{ flex: 1 }} />
        <div style={{ position: 'relative' }}>
          <button
            title="More"
            onClick={() => setMenuOpen((o) => !o)}
            style={{
              border: 'none',
              background: 'transparent',
              color: 'var(--faint)',
              fontSize: 12,
              lineHeight: 1,
              padding: 2,
              cursor: 'pointer',
            }}
          >
            ⋯
          </button>
          {menuOpen && (
            <CardMenu
              ticket={ticket}
              step={step}
              agents={agents}
              projectId={projectId}
              onClose={() => setMenuOpen(false)}
            />
          )}
        </div>
      </div>

      <div
        className="selectable"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={onOpen}
        title={onOpen ? 'Open this ticket' : undefined}
        style={{
          fontSize: 12.5,
          fontWeight: 500,
          lineHeight: 1.45,
          color: done || dim ? 'var(--ink-2)' : 'var(--ink)',
          cursor: onOpen ? 'pointer' : 'default',
        }}
      >
        {ticket.title}
      </div>

      {proposal && <RouteProposal projectId={projectId} route={proposal} />}

      {findings.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <button
            onClick={() => setShowFindings((s) => !s)}
            style={{
              border: 'none',
              background: 'transparent',
              padding: 0,
              textAlign: 'left',
              font: '400 9.5px var(--font-heading)',
              letterSpacing: '.08em',
              textTransform: 'uppercase',
              color: 'var(--danger)',
              cursor: 'pointer',
            }}
          >
            {showFindings ? '▾' : '▸'} {findings.length} to fix
          </button>
          {showFindings &&
            findings.map((f) => (
              <div
                key={f.id}
                className="selectable"
                style={{
                  fontSize: 11,
                  lineHeight: 1.5,
                  color: 'var(--ink-2)',
                  borderLeft: `2px solid ${f.severity === 'must' ? 'var(--danger)' : 'var(--line)'}`,
                  paddingLeft: 6,
                }}
              >
                <span className="meta">{f.severity}</span> {f.summary}
                {f.file && (
                  <span className="meta" style={{ color: 'var(--faint)' }}>
                    {' '}
                    {f.file}
                    {f.line ? `:${f.line}` : ''}
                  </span>
                )}
              </div>
            ))}
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <RouteMarker steps={route?.steps ?? []} showLabel={false} />
        <div style={{ flex: 1 }} />
        {assignee && (
          <>
            <Avatar
              initials={assignee.avatarInitials}
              seed={assignee.id}
              size={17}
              isPilot={assignee.isPilot}
            />
            <span className="meta">{assignee.name}</span>
          </>
        )}
      </div>
    </div>
  )
}

/**
 * Shown only when the Pilot said it was not sure. Normally it decides and the route is
 * already live — this card is the exception, not the flow.
 */
function RouteProposal({ projectId, route }: { projectId: string; route: TicketRoute }) {
  const [busy, setBusy] = useState(false)
  const [steps, setSteps] = useState<StepKind[]>(route.steps.map((s) => s.kind))

  const toggle = (k: StepKind): void =>
    setSteps((cur) => (cur.includes(k) ? cur.filter((x) => x !== k) : [...STEP_KINDS].filter((x) => cur.includes(x) || x === k)))

  const accept = async (): Promise<void> => {
    if (steps.length === 0) return
    setBusy(true)
    // Without the catch, a failed accept left busy=true forever and both buttons on the card
    // were dead until an unrelated bus event re-rendered it.
    await window.vibepilot.routes
      .accept(
        projectId,
        route.id,
        steps.map((kind) => ({ kind, note: route.steps.find((s) => s.kind === kind)?.note ?? null })),
      )
      .catch(() => setBusy(false))
  }

  return (
    <div
      style={{
        border: '1px solid var(--color-accent-400)',
        background: 'var(--color-accent-100)',
        padding: 8,
        display: 'flex',
        flexDirection: 'column',
        gap: 7,
      }}
    >
      <span className="cap">The Pilot isn't sure how to handle this</span>
      <div className="selectable" style={{ fontSize: 11.5, lineHeight: 1.5, color: 'var(--ink-2)' }}>
        {route.rationale}
      </div>
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        {STEP_KINDS.map((k) => {
          const on = steps.includes(k)
          return (
            <button
              key={k}
              onClick={() => toggle(k)}
              title={on ? 'Drop this step' : 'Add this step'}
              style={{
                border: `1px solid ${on ? 'var(--accent)' : 'var(--line)'}`,
                background: on ? 'var(--color-accent-200)' : 'transparent',
                color: on ? 'var(--ink)' : 'var(--faint)',
                font: '400 9px var(--font-heading)',
                letterSpacing: '.08em',
                textTransform: 'uppercase',
                padding: '3px 7px',
              }}
            >
              {STEP_LABEL[k]}
            </button>
          )
        })}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span className="meta tnum">{routeSummary(steps.map((kind) => ({ kind })))}</span>
        <div style={{ flex: 1 }} />
        <Button kind="primary" height={24} disabled={busy || steps.length === 0} onClick={() => void accept()}>
          Start
        </Button>
        <Button
          height={24}
          disabled={busy}
          onClick={() => {
            setBusy(true)
            void window.vibepilot.routes.reject(projectId, route.id)
          }}
        >
          Not this
        </Button>
      </div>
    </div>
  )
}

/**
 * The card's `⋯` menu.
 *
 * In v1 this button archived the ticket with no confirmation and no other options, which is
 * a lot of authority for an ellipsis. Reassigning was in the design comp and fell out.
 */
function CardMenu({
  ticket,
  step,
  agents,
  projectId,
  onClose,
}: {
  ticket: Ticket
  step: ReturnType<typeof activeStep>
  agents: Agent[]
  projectId: string
  onClose: () => void
}) {
  const roster = agents.filter((a) => !a.isPilot && a.isRoster)
  const current = step?.assigneeAgentId ?? ticket.assigneeAgentId

  const item: React.CSSProperties = {
    display: 'block',
    width: '100%',
    textAlign: 'left',
    border: 'none',
    background: 'transparent',
    padding: '5px 9px',
    fontSize: 11.5,
    color: 'var(--ink)',
    cursor: 'pointer',
  }

  return (
    <>
      {/* Click-away. A menu you can only close by picking something is a trap. */}
      <div style={{ position: 'fixed', inset: 0, zIndex: 20 }} onClick={onClose} />
      <div
        style={{
          position: 'absolute',
          right: 0,
          top: 18,
          zIndex: 21,
          minWidth: 170,
          border: '1px solid var(--line)',
          background: 'var(--surface)',
          boxShadow: 'var(--shadow-md)',
          padding: '4px 0',
        }}
      >
        <div className="cap" style={{ padding: '3px 9px 4px' }}>
          Hand it to
        </div>
        {roster.length === 0 ? (
          <div style={{ ...item, color: 'var(--faint)', cursor: 'default' }}>
            Nobody on the roster yet
          </div>
        ) : (
          roster.map((a) => (
            <button
              key={a.id}
              disabled={a.id === current}
              style={{
                ...item,
                color: a.id === current ? 'var(--faint)' : 'var(--ink)',
                cursor: a.id === current ? 'default' : 'pointer',
              }}
              onMouseEnter={(e) => {
                if (a.id !== current) e.currentTarget.style.background = 'var(--line-2)'
              }}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
              onClick={() => {
                onClose()
                // Routed through the Pilot rather than done behind its back: it is the one
                // that has to brief them, and it would otherwise find out by surprise.
                void window.vibepilot.comms.tellPilot(
                  projectId,
                  `Please put ${a.name} on #${ticket.number} — ${ticket.title}.`,
                )
              }}
            >
              {a.name}
              {a.id === current ? ' · already on it' : ` · ${a.role}`}
            </button>
          ))
        )}

        <div style={{ height: 1, background: 'var(--line-2)', margin: '4px 0' }} />
        <button
          style={item}
          onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--line-2)')}
          onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
          onClick={() => {
            onClose()
            void window.vibepilot.tickets.archive(projectId, ticket.id)
          }}
        >
          Archive
        </button>
      </div>
    </>
  )
}

/**
 * A lane you can drop a card into.
 *
 * `@dnd-kit` was a dependency in v1 and was never imported — the board looked draggable and
 * wasn't. This is the smallest thing that makes it true.
 */
function LaneDrop({
  lane,
  style,
  children,
}: {
  lane: Lane
  style: React.CSSProperties
  children: React.ReactNode
}) {
  const { setNodeRef, isOver } = useDroppable({ id: lane })
  return (
    <div
      ref={setNodeRef}
      style={{
        ...style,
        // A dashed outline rather than a fill: the board is dense, and a colour wash would
        // hide the cards you are deciding between.
        outline: isOver ? '1px dashed var(--accent)' : undefined,
        outlineOffset: 2,
      }}
    >
      {children}
    </div>
  )
}

/**
 * A proposed breakdown, before any ticket exists.
 *
 * This is the one place vibePilot deliberately asks rather than decides — *"there should be
 * a bit more interactivity, talking to the Pilot planning it"*. You drop pieces you don't
 * want; what's left becomes the tickets.
 */
function SplitProposal({ epic, projectId }: { epic: Epic; projectId: string }) {
  const [dropped, setDropped] = useState<Set<number>>(new Set())
  const [busy, setBusy] = useState(false)

  const kept = epic.pieces
    .map((p, i) => ({ p, i }))
    .filter(({ i }) => !dropped.has(i))

  const accept = (): void => {
    setBusy(true)
    // Indexes shift when pieces are dropped, so dependencies are remapped onto the new
    // positions — otherwise dropping piece 1 would silently point piece 3 at the wrong thing.
    const remap = new Map(kept.map(({ i }, newIndex) => [i, newIndex]))
    const pieces: EpicPiece[] = kept.map(({ p }) => ({
      title: p.title,
      body: p.body,
      sizeNote: p.sizeNote,
      dependsOnIndexes: p.dependsOnIndexes
        .map((old) => remap.get(old))
        .filter((n): n is number => n !== undefined),
    }))
    void window.vibepilot.epics.accept(projectId, epic.id, pieces).catch(() => setBusy(false))
  }

  return (
    <div style={{ padding: '0 20px 12px', flex: 'none' }}>
      <div
        style={{
          border: '1px solid var(--accent)',
          background: 'var(--surface)',
          boxShadow: 'var(--shadow-sm)',
          padding: 11,
          display: 'flex',
          flexDirection: 'column',
          gap: 9,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span className="cap">Suggested breakdown</span>
          <span style={{ fontSize: 13, fontWeight: 600 }}>{epic.title}</span>
          <div style={{ flex: 1 }} />
          <span className="meta tnum">
            {kept.length} of {epic.pieces.length}
          </span>
        </div>

        <div className="selectable" style={{ fontSize: 12, lineHeight: 1.55, color: 'var(--ink-2)' }}>
          {epic.summary}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          {epic.pieces.map((p, i) => {
            const out = dropped.has(i)
            return (
              <div
                key={i}
                style={{
                  display: 'flex',
                  alignItems: 'baseline',
                  gap: 8,
                  padding: '5px 7px',
                  border: '1px solid var(--line-2)',
                  borderLeft: `2px solid ${out ? 'var(--line)' : epicColour(epic.colourIndex)}`,
                  opacity: out ? 0.45 : 1,
                }}
              >
                <span className="meta tnum">{i + 1}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontSize: 12.5,
                      fontWeight: 500,
                      textDecoration: out ? 'line-through' : 'none',
                    }}
                  >
                    {p.title}
                  </div>
                  {p.body && (
                    <div style={{ fontSize: 11.5, lineHeight: 1.5, color: 'var(--ink-2)' }}>
                      {p.body}
                    </div>
                  )}
                </div>
                {p.dependsOnIndexes.length > 0 ? (
                  <span className="meta" style={{ color: 'var(--faint)' }}>
                    after {p.dependsOnIndexes.map((n) => n + 1).join(', ')}
                  </span>
                ) : (
                  <span className="meta" style={{ color: 'var(--faint)' }}>
                    can start now
                  </span>
                )}
                <button
                  onClick={() =>
                    setDropped((cur) => {
                      const next = new Set(cur)
                      if (next.has(i)) next.delete(i)
                      else next.add(i)
                      return next
                    })
                  }
                  title={out ? 'Put it back' : 'Drop this piece'}
                  style={{
                    border: 'none',
                    background: 'transparent',
                    color: 'var(--faint)',
                    font: '400 9px var(--font-heading)',
                    letterSpacing: '.08em',
                    textTransform: 'uppercase',
                    padding: 2,
                    cursor: 'pointer',
                  }}
                >
                  {out ? 'keep' : 'drop'}
                </button>
              </div>
            )
          })}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span className="meta" style={{ color: 'var(--faint)' }}>
            Nothing exists yet. Reply in chat if you want it shaped differently.
          </span>
          <div style={{ flex: 1 }} />
          <Button kind="primary" height={26} disabled={busy || kept.length === 0} onClick={accept}>
            Create {kept.length} {kept.length === 1 ? 'ticket' : 'tickets'}
          </Button>
          <Button
            height={26}
            disabled={busy}
            onClick={() => {
              setBusy(true)
              void window.vibepilot.epics.reject(projectId, epic.id)
            }}
          >
            Not like this
          </Button>
        </div>
      </div>
    </div>
  )
}

function NewTicketForm({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const [title, setTitle] = useState('')

  const submit = async (): Promise<void> => {
    if (!title.trim()) return
    // Lands in the backlog with no route. The Pilot is nudged to decide one — creating a
    // ticket is not the same as starting it.
    await window.vibepilot.tickets.create({ projectId, title: title.trim(), lane: 'backlog' })
    onClose()
  }

  return (
    <div style={{ padding: '0 20px 12px', flex: 'none' }}>
      <div
        style={{
          border: '1px solid var(--accent)',
          background: 'var(--surface)',
          boxShadow: 'var(--shadow-sm)',
          padding: 10,
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}
      >
        <Input
          value={title}
          onChange={setTitle}
          autoFocus
          height={28}
          placeholder="What needs doing?"
          onEnter={() => void submit()}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="meta" style={{ color: 'var(--faint)' }}>
            The Pilot decides how to handle it and tells you.
          </span>
          <div style={{ flex: 1 }} />
          <Button kind="primary" height={26} disabled={!title.trim()} onClick={() => void submit()}>
            Add
          </Button>
          <Button height={26} onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  )
}
