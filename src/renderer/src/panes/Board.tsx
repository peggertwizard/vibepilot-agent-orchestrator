import { useEffect, useMemo, useState } from 'react'
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
} from '@shared/types'
import { Avatar, Button, Empty, Input, RouteMarker, SectionRule, Tag } from '../components/ui'
import { WorkingBars } from '../components/ui/Blueprint'
import { Icon } from '../components/ui/Icon'
import { TicketDetail } from '../components/TicketDetail'

export function Board({
  project,
  tickets,
  routes,
  findings,
  epics,
  agents,
  focusTicketId,
  onFocusConsumed,
}: {
  project: Project
  tickets: Ticket[]
  routes: TicketRoute[]
  findings: Finding[]
  epics: Epic[]
  agents: Agent[]
  /** A ticket to open, set by something outside the board. Consumed once, then cleared. */
  focusTicketId?: string | null
  onFocusConsumed?: () => void
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

  /*
   * Something outside the board asked for a ticket to be opened.
   *
   * The Needs-you list can act on most things in place, but a merge and a stuck step both end
   * with "look at the ticket" — and a popover that switches you to the Board and then leaves
   * you to find the card yourself has not really taken you anywhere. Consumed once and cleared
   * by the caller, so closing the panel does not immediately re-open it.
   */
  useEffect(() => {
    if (!focusTicketId) return
    setOpenTicketId(focusTicketId)
    onFocusConsumed?.()
  }, [focusTicketId, onFocusConsumed])
  /** Show only this epic's children. Null = the whole board. */
  const [isolated, setIsolated] = useState<string | null>(null)

  /**
   * A drag has to beat a click: every card has buttons on it, and without a distance
   * threshold a press on the archive button would start a drag instead of pressing it.
   */
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

  /**
   * You can drag a card to the two columns that describe a *decision you made*. You cannot
   * drag one into the three that describe *what is happening*.
   *
   * Every column is now derived from the route and the live processes, so dropping a card
   * into In progress would either be ignored on the next read — the board silently undoing
   * you — or would have to fake a running agent. Backlog and Done are different: parking a
   * ticket and calling one finished are both things only you can decide, so those drops
   * write something real.
   */
  const DROPPABLE: readonly Lane[] = ['backlog', 'done']

  const onDragEnd = (e: DragEndEvent): void => {
    const lane = e.over?.id as Lane | undefined
    const ticketId = String(e.active.id)
    if (!lane || !DROPPABLE.includes(lane)) return
    const t = allLive.find((x) => x.id === ticketId)
    if (!t || t.lane === lane) return
    void window.vibepilot.tickets.update(project.id, ticketId, { lane })
  }

  const allLive = useMemo(() => tickets.filter((t) => !t.archivedAt), [tickets])
  // Isolating narrows the board rather than opening a separate view: you still see the
  // pieces in their real lanes, which is the only way the board keeps telling the truth.
  const live = useMemo(
    () => (isolated ? allLive.filter((t) => t.epicId === isolated) : allLive),
    [allLive, isolated],
  )

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
  const stuckCount = live.filter((t) => t.stuck).length
  /** What the pause toggle is currently holding back. Zero while unpaused. */
  const queuedCount = project.launchPaused ? byLane('todo').length : 0
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

  /*
   * `allLive`, not `live` — the difference is the epic filter.
   *
   * Testing the filtered list meant isolating a breakdown whose pieces were all archived
   * replaced the whole board with "No tickets yet", including the breakdown strip and the
   * "Show everything" button that were the only way back out. The board looked empty, the
   * project was not, and there was nothing to press.
   */
  if (allLive.length === 0 && !creating) {
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

        {/*
          Pause stops the *next* ticket starting. Nothing already running is touched.

          Beside New ticket because the two are the same kind of thing — start more work, or
          stop more work starting — and quiet rather than accented: it is a control you reach
          for occasionally, not the primary action on the screen. It only shouts once it is on,
          and then only because a paused board that looks unpaused is the worst of both.
        */}
        <Button
          kind="ghost"
          height={28}
          title={
            project.launchPaused
              ? 'Paused. Nothing new will start; anything already running carries on. Click to resume.'
              : 'Stop the next ticket starting. Work already running is not affected.'
          }
          style={
            project.launchPaused
              ? { borderColor: 'var(--warn)', color: 'var(--warn)' }
              : { color: 'var(--muted)' }
          }
          onClick={() => {
            void window.vibepilot.projects.update(project.id, {
              launchPaused: !project.launchPaused,
            })
          }}
        >
          <Icon name={project.launchPaused ? 'play' : 'pause'} size={12} />
          {project.launchPaused
            ? `Paused${queuedCount > 0 ? ` · ${queuedCount} waiting` : ''}`
            : 'Pause'}
        </Button>

        <span style={{ width: 1, height: 18, background: 'var(--line)' }} />
        {awaitingRoute > 0 && <Tag tone="accent">route to decide · {awaitingRoute}</Tag>}
        {stuckCount > 0 && (
          <Tag tone="warn" title="A step is active and nothing is running it.">
            stuck · {stuckCount}
          </Tag>
        )}
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

      {creating && <NewTicketForm projectId={project.id} tickets={allLive} onClose={() => setCreating(false)} />}

      {/* Split proposals live in the Needs-you popover — see components/NeedsYouPopover.tsx. */}

      {/*
        The breakdown strip, finally labelled.

        It was an unheaded row of unexplained chips — a colour bar, a title and "0/3" — sitting
        directly under the route legend, which reads as though it captions this. *"what is
        this?"* was the entirely reasonable response. Clicking one silently filters every
        column, so it needs to say both what it is and what pressing it does.
      */}
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
          <span className="cap">Breakdowns</span>
          <span className="meta" style={{ color: 'var(--faint)' }}>
            click one to show only its tickets
          </span>
          {liveEpics.map((e) => {
            const kids = allLive.filter((t) => t.epicId === e.id)
            const done = kids.filter((t) => t.lane === 'done').length
            const on = isolated === e.id
            return (
              <button
                key={e.id}
                onClick={() => setIsolated(on ? null : e.id)}
                aria-pressed={on}
                title={
                  (on ? 'Show the whole board again' : `Show only ${e.title}`) +
                  ` — ${done} of ${kids.length} done`
                }
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

      <div
        className="scroll-y"
        style={{ flex: 1, padding: '0 20px 20px', minHeight: 0, minWidth: 0 }}
      >
        <DndContext sensors={sensors} onDragEnd={onDragEnd}>
        {/*
          Five columns want room, and a fixed `minWidth` is the wrong way to ask for it: it
          made the whole app scroll sideways when the window got narrow, moving the header and
          the composer off screen along with the board. A grid that wraps keeps every column
          readable and lets the window be whatever size it is.
        */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))',
            gap: 12,
            alignItems: 'flex-start',
          }}
        >
          {LANES.map((lane) =>
            lane === 'in_progress' ? (
              <LaneDrop
                key={lane}
                lane={lane}
                droppable={DROPPABLE.includes(lane)}
                style={{
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
                droppable={DROPPABLE.includes(lane)}
                style={{ display: 'flex', flexDirection: 'column', gap: 7, minHeight: 60 }}
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
        {/*
          What is still in the way, not what was listed when the ticket was written.

          This printed every dependency for ever, so a ticket whose blockers had all landed
          still read "after #6, #7" — and when #7 finished before #6 there was nothing to say
          #6 was the one holding things up. `waitingFor` is the unmet subset, derived.
        */}
        {ticket.waitingFor.length > 0 ? (
          <Tag
            tone="warn"
            title={`Nothing can start on this until ${ticket.waitingFor
              .map((n) => `#${n}`)
              .join(' and ')} ${ticket.waitingFor.length === 1 ? 'lands' : 'land'}.`}
          >
            waiting for {ticket.waitingFor.map((n) => `#${n}`).join(', ')}
          </Tag>
        ) : (
          ticket.dependsOn.length > 0 && (
            <span
              className="meta"
              style={{ color: 'var(--faint)' }}
              title="Everything this depended on has landed."
            >
              after {ticket.dependsOn.map((n) => `#${n}`).join(', ')} · clear
            </span>
          )
        )}
        {passes > 1 && <Tag tone="warn">pass {passes}</Tag>}
        {ticket.readyToMerge && <Tag tone="ok">ready</Tag>}
        {/*
          A step that is active with nobody running it. This used to be silent — the card
          looked identical to work in progress, and the only way to tell was to check the
          agents rail and notice the assignee was idle. It stayed like that for hours.
        */}
        {ticket.stuck && (
          <Tag tone="warn" title={ticket.laneBecause}>
            stuck
          </Tag>
        )}
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

      {/*
        A pointer, not a second copy of the decision.

        This used to render the whole proposal inline, which — once the tray existed — meant one
        proposed route drew two cards with two Start buttons, and answering one left the other
        sitting there. The tray is the one place decisions are made; the card's job is to say
        that this ticket has one waiting, which the accent border already half-says.
      */}
      {proposal && (
        <span className="meta" style={{ color: 'var(--accent-ink)' }}>
          Waiting for you to start it — press Needs you above
        </span>
      )}

      {/*
        Clearing a finished ticket, without going through a menu.

        Auto-archive collects these after a few days anyway; this is for the moment you have
        just looked at something, are done with it, and want it off the board now. No
        confirmation: it is reversible and the Archive toggle lists it.
      */}
      {done && (
        <button
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation()
            void window.vibepilot.tickets.archive(projectId, ticket.id)
          }}
          className="meta"
          title="Move it to the archive. It stays readable there."
          style={{
            alignSelf: 'flex-start',
            border: '1px solid var(--line)',
            background: 'transparent',
            color: 'var(--faint)',
            cursor: 'pointer',
            padding: '2px 7px',
          }}
        >
          Archive
        </button>
      )}

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
        {/*
          Filing something away and abandoning it are not the same act, and they were one
          button called "Archive" — pressed on a running ticket it left the teammate working in
          a worktree on a ticket that had left the board.

          Done: no confirmation. It is reversible, the Archive toggle lists it, and asking about
          something harmless teaches people to click through the dialogs that matter.
          Not done: confirm, and stop whoever is on it first.
        */}
        <button
          style={item}
          onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--line-2)')}
          onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
          onClick={() => {
            onClose()
            if (ticket.lane === 'done') {
              void window.vibepilot.tickets.archive(projectId, ticket.id)
              return
            }
            const ok = window.confirm(
              `Cancel #${ticket.number}?\n\n${ticket.title}\n\n` +
                `Anyone working on it is stopped, and the ticket moves to the archive. ` +
                `Nothing already committed to its branch is deleted.`,
            )
            if (!ok) return
            const who = ticket.assigneeAgentId
            void (who ? window.vibepilot.agents.stop(who) : Promise.resolve()).then(() =>
              window.vibepilot.tickets.archive(projectId, ticket.id),
            )
          }}
        >
          {ticket.lane === 'done' ? 'Archive' : 'Cancel ticket'}
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
  droppable,
  style,
  children,
}: {
  lane: Lane
  /** False for the derived columns — see `DROPPABLE` in Board. */
  droppable: boolean
  style: React.CSSProperties
  children: React.ReactNode
}) {
  const { setNodeRef, isOver } = useDroppable({ id: lane, disabled: !droppable })
  return (
    <div
      ref={setNodeRef}
      style={{
        ...style,
        // A dashed outline rather than a fill: the board is dense, and a colour wash would
        // hide the cards you are deciding between.
        outline: isOver && droppable ? '1px dashed var(--accent)' : undefined,
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
export function SplitProposal({ epic, projectId }: { epic: Epic; projectId: string }) {
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
            Don&rsquo;t split it
          </Button>
        </div>
      </div>
    </div>
  )
}

function NewTicketForm({
  projectId,
  onClose,
  tickets,
}: {
  projectId: string
  onClose: () => void
  /** Open tickets, so a dependency can be picked rather than described in prose. */
  tickets: Ticket[]
}) {
  const [title, setTitle] = useState('')
  /*
   * Everything below the title is behind a disclosure.
   *
   * One field is the right default — most tickets are a sentence, and the Pilot works out the
   * rest. But "most" is not "all", and there was no way at all to say *this one is expensive,
   * cap it* or *this one waits for #6* or *plan it first and let me look*: those existed in
   * the database, in the IPC layer and in the Pilot's tools, and nowhere a person could reach.
   */
  const [more, setMore] = useState(false)
  const [body, setBody] = useState('')
  const [budget, setBudget] = useState('')
  const [dependsOn, setDependsOn] = useState<number[]>([])
  const [planFirst, setPlanFirst] = useState(false)

  const submit = async (): Promise<void> => {
    if (!title.trim()) return
    // Lands in the backlog with no route. The Pilot is nudged to decide one — creating a
    // ticket is not the same as starting it.
    await window.vibepilot.tickets.create({
      projectId,
      title: title.trim(),
      lane: 'backlog',
      body: body.trim(),
      needsPlanning: planFirst,
      budgetUsd: budget.trim() ? Math.max(0, Number(budget) || 0) : null,
      dependsOn,
    })
    onClose()
  }

  const openTickets = tickets.filter((t) => t.lane !== 'done').slice(0, 40)

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

        {more && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span className="cap">Detail</span>
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={4}
                placeholder="Anything the person doing this needs to know."
                className="selectable"
                style={{
                  width: '100%',
                  resize: 'vertical',
                  border: '1px solid var(--line)',
                  background: 'var(--paper)',
                  color: 'var(--ink)',
                  font: '400 12px var(--font-body)',
                  lineHeight: 1.6,
                  padding: 7,
                  outline: 'none',
                }}
              />
            </label>

            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10 }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, width: 130 }}>
                <span className="cap">Budget $</span>
                <Input
                  value={budget}
                  onChange={setBudget}
                  height={26}
                  placeholder="default"
                />
              </label>
              {/*
                A checkbox rather than a route editor. The route is the Pilot's proposal and
                you get to argue with it on the card; this only says the one thing the Pilot
                cannot work out on its own — that you want to read the plan before anything is
                built.
              */}
              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  fontSize: 12,
                  color: 'var(--ink-2)',
                  cursor: 'pointer',
                  paddingBottom: 5,
                }}
              >
                <input
                  type="checkbox"
                  checked={planFirst}
                  onChange={(e) => setPlanFirst(e.target.checked)}
                />
                Plan first — I sign off before anything is built
              </label>
            </div>

            {openTickets.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                <span className="cap">Waits for</span>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                  {openTickets.map((t) => {
                    const on = dependsOn.includes(t.number)
                    return (
                      <button
                        key={t.id}
                        title={t.title}
                        onClick={() =>
                          setDependsOn((cur) =>
                            on ? cur.filter((n) => n !== t.number) : [...cur, t.number],
                          )
                        }
                        style={{
                          border: `1px solid ${on ? 'var(--accent)' : 'var(--line)'}`,
                          background: on ? 'var(--color-accent-200)' : 'transparent',
                          color: on ? 'var(--ink)' : 'var(--faint)',
                          font: '400 10px var(--font-heading)',
                          padding: '3px 7px',
                          cursor: 'pointer',
                        }}
                      >
                        #{t.number}
                      </button>
                    )
                  })}
                </div>
                <span className="meta" style={{ color: 'var(--faint)' }}>
                  It stays in the backlog until these have landed.
                </span>
              </div>
            )}
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            onClick={() => setMore((m) => !m)}
            className="meta"
            style={{
              border: 'none',
              background: 'transparent',
              color: 'var(--accent-ink)',
              cursor: 'pointer',
              padding: 0,
            }}
          >
            {more ? 'Fewer options' : 'More options'}
          </button>
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
