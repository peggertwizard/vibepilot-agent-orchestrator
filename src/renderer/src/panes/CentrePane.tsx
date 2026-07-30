import { useState } from 'react'
import type { Attachment, BranchOverview, Project } from '@shared/types'
import { Button, Tabs, type TabDef } from '../components/ui'
import { Icon } from '../components/ui/Icon'
import { NeedsYouDot } from '../components/ui/Blueprint'
import type { ProjectData } from '../stores/useProjectData'
import { Messages, DraftCard, QuestionCard } from './Messages'
import { Board, SplitProposal } from './Board'
import { PresentationCard } from '../components/PresentationCard'
import {
  NeedsYouPopover,
  buildNeedsYouItems,
  type NeedsYouItem,
} from '../components/NeedsYouPopover'
import { BranchCard, GateCard, StuckCard } from '../components/NeedsYouCards'
import { Memory } from './Memory'
import { Team, HireCard } from './Team'
import { useResolvedModels } from '../stores/useResolvedModels'

type CentreTab = 'messages' | 'board' | 'team' | 'memory'

/** Stable identity, so an empty attachment list does not remount the composer. */
const EMPTY_ATTACHMENTS: Attachment[] = []

export function CentrePane({
  project,
  data,
  branches,
  leftCollapsed,
  rightCollapsed,
  onToggleLeft,
  onToggleRight,
  model,
  onModelChange,
}: {
  leftCollapsed: boolean
  rightCollapsed: boolean
  onToggleLeft: () => void
  onToggleRight: () => void
  project: Project
  data: ProjectData
  /** What git actually says, so the chip below can stop asserting a setting. */
  branches: BranchOverview | null
  model: string
  onModelChange: (m: string) => void
}) {
  const [tab, setTab] = useState<CentreTab>('messages')

  /**
   * The composer's contents live HERE, not inside Messages.
   *
   * Switching tabs unmounts the Messages pane, and React state goes with it — so a half
   * written message was silently thrown away the moment you clicked Board to check
   * something. Keyed by project so two projects do not share one draft.
   */
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [attachments, setAttachments] = useState<Record<string, Attachment[]>>({})

  const pilotAgent = data.agents.find((a) => a.isPilot) ?? null
  const live = data.tickets.filter((t) => !t.archivedAt)
  const inProgress = live.filter((t) => t.lane === 'in_progress').length
  /** One predicate. It was written twice, nine lines apart, and read as two different things. */
  const ready = live.filter((t) => t.readyToMerge).length
  /*
   * Everything that is actually on you.
   *
   * This counted questions and drafts only, so two route cards sitting unpressed, two tickets
   * ready to merge and a teammate waiting to be hired all read as "nothing waiting on you" —
   * which is worse than showing nothing at all, because it is a confident wrong answer.
   */
  /*
   * Work that says it is running and is not.
   *
   * This used to re-derive the condition here from routes and agent statuses — a second copy
   * of a rule that the board also had, which is how the two came to disagree. It is now one
   * value computed in `shared/board.ts` and stamped on the ticket, so the header, the card
   * and the Pilot cannot say different things about the same ticket.
   */
  const resolved = useResolvedModels(data.agents)
  const stuck = live.filter((t) => t.stuck).length

  /*
   * Where the repository actually is. `defaultBaseBranch` is where merges go — a preference —
   * and the two disagreeing is a state the app has to say out loud rather than average over.
   */
  const here = branches?.current ?? null
  const diverged = !!here && here !== project.defaultBaseBranch

  /*
   * Everything waiting on you, as one list.
   *
   * The badge and the contents are now the same array, which they were not: the count summed
   * questions + drafts + routes + merges + hires while the tray rendered splits it never
   * counted, so the number on the button and the number of cards behind it could differ. One
   * derivation, one count, one order.
   */
  const needsYou: NeedsYouItem[] = buildNeedsYouItems({
    questions: data.questions,
    tickets: data.tickets,
    routes: data.routes,
    drafts: data.drafts,
    epics: data.epics.filter((e) => e.status === 'proposed'),
    hires: data.hires,
    agents: data.agents,
    divergedFrom:
      diverged && here
        ? { here, base: project.defaultBaseBranch, ahead: branches?.currentAhead ?? 0 }
        : null,
    render: {
      branch: (d) => (
        <BranchCard here={d.here} base={d.base} ahead={d.ahead} projectId={project.id} />
      ),
      question: (q) => <QuestionCard q={q} projectId={project.id} agents={data.agents} />,
      gate: (t) => <GateCard ticket={t} projectId={project.id} />,
      split: (e) => <SplitProposal epic={e} projectId={project.id} />,
      route: (r) => (
        <PresentationCard
          route={r.route}
          ticket={r.ticket}
          agents={data.agents}
          projectId={project.id}
        />
      ),
      draft: (d) => <DraftCard draft={d} projectId={project.id} />,
      stuck: (a) => <StuckCard agent={a} />,
    },
    renderHire: (h) => <HireCard hire={h} projectId={project.id} resolved={resolved} />,
  })
  const waiting = needsYou.length

  const [needsYouOpen, setNeedsYouOpen] = useState(false)
  /** Set when an item says "open ticket"; Board consumes it once and clears it. */
  const [boardFocusId, setBoardFocusId] = useState<string | null>(null)

  const tabs: TabDef<CentreTab>[] = [
    { id: 'messages', label: 'Messages' },
    { id: 'board', label: 'Board', count: live.length || null },
    // Comms had its own tab and was always empty, because dm_agent and shoutout wrote a row
    // and never delivered anything. Now that they deliver, the traffic belongs in the one
    // timeline you already read, as a collapsed line — not in a second place to check.
    { id: 'team', label: 'Team', count: data.agents.length || null, dot: data.hires.length > 0 },
    { id: 'memory', label: 'Memory' },
  ]

  const summary = [
    inProgress > 0 ? `${inProgress} in progress` : null,
    ready > 0 ? `${ready} ready to merge` : null,
    data.questions.length > 0 ? `${data.questions.length} question${data.questions.length === 1 ? '' : 's'}` : null,
  ].filter(Boolean)

  return (
    <main
      style={{
        flex: 1,
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--surface)',
        borderRight: '1px solid var(--line)',
      }}
    >
      {/* `relative` so the popover anchors to the header rather than the viewport. */}
      <header style={{ padding: '14px 20px 0', flex: 'none', position: 'relative' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <h1
            className="ellip"
            style={{ font: '600 17px var(--font-heading)', letterSpacing: '-0.015em', margin: 0 }}
          >
            {project.name}
          </h1>
          {/*
            A bare "main" with a green dot meant nothing to anyone who did not already know it
            was a git branch. The icon and the tooltip say what it is and why it is on screen:
            this is the branch work merges into, and nothing reaches it without the user.
          */}
          {/*
            The branch you are *on*, not the branch merges land in.

            This chip rendered `defaultBaseBranch` — a setting, written once when the project
            was added. So a project folder checked out on a feature branch had a chip
            confidently saying "main" while the dev server, which mounts that folder, served
            something else entirely. Merged work then "did not appear", and the obvious
            explanations — did it merge? is hot reload broken? — are all wrong, so the search
            goes anywhere but here. An afternoon.

            Both branches matter and they are different things, so both are shown when they
            differ, and the disagreement is the loud part.
          */}
          <span
            title={
              diverged
                ? `Your project folder is checked out on "${here}". Merges land in ` +
                  `"${project.defaultBaseBranch}" — so anything merged is NOT what this folder, ` +
                  `or a dev server watching it, is currently showing.`
                : `Base branch — teammates branch from "${project.defaultBaseBranch}" and merges land there. Nothing reaches it without you.`
            }
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              padding: '2px 7px',
              border: `1px solid ${diverged ? 'var(--caution)' : 'var(--line)'}`,
              borderRadius: 'var(--radius-md)',
              font: '400 10px var(--font-heading)',
              color: diverged ? 'var(--caution)' : 'var(--muted)',
              flex: 'none',
            }}
          >
            <Icon name="branch" size={10} />
            {diverged ? `on ${here} · merges to ${project.defaultBaseBranch}` : project.defaultBaseBranch}
          </span>
          {summary.length > 0 && (
            <span className="meta ellip" style={{ fontSize: 11 }}>
              {summary.join(' · ')}
            </span>
          )}
          <div style={{ flex: 1 }} />
          {waiting > 0 ? (
            <Button
              height={28}
              /*
               * It shows you the things rather than guessing where they are.
               *
               * It used to switch to whichever tab a short ladder of conditions picked. That
               * was already better than always opening Messages, and wrong in the same way:
               * three kinds of decision could be outstanding and pressing the button committed
               * to one of them, silently, without saying what the others were. Now it opens
               * the list, and the list is the same thing the number counts.
               */
              onClick={() => setNeedsYouOpen((o) => !o)}
              title="Everything waiting on you"
              style={{
                border: '1px solid var(--accent)',
                background: 'var(--accent-soft)',
                color: 'var(--accent-ink)',
                fontWeight: 600,
              }}
            >
              <NeedsYouDot />
              Needs you · {waiting}
            </Button>
          ) : stuck > 0 ? (
            // Never silently. Something claims to be running and is not.
            <span className="meta" style={{ color: 'var(--caution)', fontWeight: 600 }}>
              {stuck === 1 ? '1 ticket is stuck' : `${stuck} tickets are stuck`} — nobody is
              actually working on {stuck === 1 ? 'it' : 'them'}
            </span>
          ) : (
            <span className="meta">nothing waiting on you</span>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, marginTop: 14 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <Tabs tabs={tabs} active={tab} onChange={setTab} />
          </div>
          {/*
            Fold the rails away. The board is the widest thing in the app and sits between two
            fixed-width columns you are not reading while looking at a card.
          */}
          <div style={{ display: 'flex', gap: 4, paddingBottom: 6, flex: 'none' }}>
            <PanelToggle
              side="left"
              collapsed={leftCollapsed}
              onClick={onToggleLeft}
              label="project list"
            />
            <PanelToggle
              side="right"
              collapsed={rightCollapsed}
              onClick={onToggleRight}
              label="agents"
            />
          </div>
        </div>

        <NeedsYouPopover
          items={needsYou}
          open={needsYouOpen && waiting > 0}
          onClose={() => setNeedsYouOpen(false)}
          onGo={(it) => {
            if (!it.go) return
            setTab(it.go.tab)
            if (it.go.ticketId) setBoardFocusId(it.go.ticketId)
            setNeedsYouOpen(false)
          }}
        />
      </header>

      <div
        style={{ flex: 1, minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'column' }}
      >
        {/*
          Everything waiting on you, above whatever tab you are on.

          Drafts and route cards used to render inside the Messages stream and split proposals
          only on the Board, so the two tabs showed different subsets of one idea and deciding
          anything meant hunting for where it lived. Rendered here, above the tab content, it
          is the same set of decisions from everywhere — which is also why acting on one can
          no longer leave a stale copy behind: there is only one copy.
        */}
        {/*
          `key={project.id}` on each pane, and it is load-bearing.

          None of these carried a key, so switching projects never unmounted anything — React
          reconciled the same element type in the same position and only swapped the `project`
          prop. Every piece of pane-local state then leaked across the boundary: pressing
          Curate on one project showed "Curating…" on the other, dismissing the read-the-repo
          offer on one swallowed it on the other, a typed-but-unsubmitted ticket title created
          itself on whichever project you had switched to, a stale epic filter rendered
          "No tickets yet" on a project full of tickets, and the teammate editor wrote to one
          project's roster while the other's refreshed.

          Not on CentrePane itself: the composer's drafts live here, keyed by project id
          precisely so a half-written message survives a switch.
        */}
        {tab === 'messages' && (
          <Messages
            key={project.id}
            project={project}
            messages={data.messages}
            drafts={data.drafts}
            questions={data.questions}
            agents={data.agents}
            tickets={data.tickets}
            routes={data.routes}
            comms={data.comms}
            live={pilotAgent ? (data.live[pilotAgent.id] ?? null) : null}
            model={model}
            onModelChange={onModelChange}
            draft={drafts[project.id] ?? ''}
            onDraftChange={(v) => setDrafts((d) => ({ ...d, [project.id]: v }))}
            attachments={attachments[project.id] ?? EMPTY_ATTACHMENTS}
            onAttachmentsChange={(v) => setAttachments((a) => ({ ...a, [project.id]: v }))}
          />
        )}
        {tab === 'board' && (
          <Board
            key={project.id}
            project={project}
            tickets={data.tickets}
            routes={data.routes}
            findings={data.findings}
            epics={data.epics}
            agents={data.agents}
            focusTicketId={boardFocusId}
            onFocusConsumed={() => setBoardFocusId(null)}
          />
        )}
        {tab === 'team' && <Team key={project.id} project={project} agents={data.agents} tickets={data.tickets} hires={data.hires} />}
        {tab === 'memory' && <Memory key={project.id} project={project} />}

      </div>
    </main>
  )
}

/**
 * Fold one of the side rails away.
 *
 * A bracket that points where the panel will go, rather than an icon that has to be learned.
 * Deliberately quiet: it is a preference you set once, not something to draw the eye.
 */
function PanelToggle({
  side,
  collapsed,
  onClick,
  label,
}: {
  side: 'left' | 'right'
  collapsed: boolean
  onClick: () => void
  label: string
}) {
  return (
    <button
      onClick={onClick}
      title={`${collapsed ? 'Show' : 'Hide'} the ${label}`}
      aria-label={`${collapsed ? 'Show' : 'Hide'} the ${label}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 22,
        height: 20,
        border: '1px solid var(--line)',
        background: collapsed ? 'var(--paper)' : 'transparent',
        color: collapsed ? 'var(--muted)' : 'var(--faint)',
        cursor: 'pointer',
        padding: 0,
      }}
    >
      <span
        style={{
          display: 'inline-flex',
          // Points outward when it would open, inward when it would close.
          transform:
            (side === 'left') === collapsed ? 'rotate(0deg)' : 'rotate(180deg)',
        }}
      >
        <Icon name="chevron" size={11} />
      </span>
    </button>
  )
}
