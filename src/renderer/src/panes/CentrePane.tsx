import { useState } from 'react'
import type { Attachment, Project, Ticket } from '@shared/types'
import { Button, Tabs, type TabDef } from '../components/ui'
import { Icon } from '../components/ui/Icon'
import { NeedsYouDot } from '../components/ui/Blueprint'
import type { ProjectData } from '../stores/useProjectData'
import { Messages, DraftCard } from './Messages'
import { Board, SplitProposal } from './Board'
import { PresentationCard } from '../components/PresentationCard'
import { ProposalTray, buildTrayItems } from '../components/ProposalTray'
import { Memory } from './Memory'
import { Team, HireCard } from './Team'
import { useResolvedModels } from '../stores/useResolvedModels'

type CentreTab = 'messages' | 'board' | 'team' | 'memory'

/** Stable identity, so an empty attachment list does not remount the composer. */
const EMPTY_ATTACHMENTS: Attachment[] = []

export function CentrePane({
  project,
  data,
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
  const proposedRoutes = data.routes.filter((r) => r.status === 'proposed').length

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

  /** Proposed routes paired with their ticket, for the tray. */
  const routeProposals = data.routes
    .filter((r) => r.status === 'proposed')
    .map((route) => ({ route, ticket: live.find((t) => t.id === route.ticketId) }))
    .filter((x): x is { route: (typeof data.routes)[number]; ticket: Ticket } => !!x.ticket)

  const waiting =
    data.questions.length + data.drafts.length + proposedRoutes + ready + data.hires.length

  /*
   * Which tab holds the thing that needs you, and what it is.
   *
   * Ordered by how immediate each is: a question has an agent stopped dead waiting on it; a
   * draft or a route is work that has not begun; a merge is finished work; a hire is a team
   * decision that can wait for any of them.
   */
  const [needsYouTab, needsYouWhy]: [CentreTab, string] =
    data.questions.length > 0
      ? ['messages', 'A teammate is stopped, waiting on your answer']
      : data.drafts.length > 0
        ? ['messages', 'A ticket is drafted and waiting for you to accept it']
        : proposedRoutes > 0
          ? ['board', 'A route is proposed and nothing starts until you say so']
          : ready > 0
            ? ['board', 'Finished work is waiting for you to merge it']
            : ['team', 'A teammate has been proposed for you to approve']

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
      <header style={{ padding: '14px 20px 0', flex: 'none' }}>
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
          <span
            title={`Base branch — teammates branch from "${project.defaultBaseBranch}" and merges land there. Nothing reaches it without you.`}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              padding: '2px 7px',
              border: '1px solid var(--line)',
              borderRadius: 'var(--radius-md)',
              font: '400 10px var(--font-heading)',
              color: 'var(--muted)',
              flex: 'none',
            }}
          >
            <Icon name="branch" size={10} />
            {project.defaultBaseBranch}
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
               * Go where the thing actually is.
               *
               * This always opened Messages, whatever drove the count — so a ticket ready to
               * merge sent you to a tab that says nothing about it, and the button that
               * existed to tell you what needs doing gave you the wrong answer about where.
               */
              onClick={() => setTab(needsYouTab)}
              title={needsYouWhy}
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
        <ProposalTray
          items={buildTrayItems({
            drafts: data.drafts,
            routes: routeProposals,
            epics: data.epics.filter((e) => e.status === 'proposed'),
            hires: data.hires,
            render: {
              draft: (d) => <DraftCard draft={d} projectId={project.id} />,
              route: (r) => (
                <PresentationCard
                  route={r.route}
                  ticket={r.ticket}
                  agents={data.agents}
                  projectId={project.id}
                />
              ),
              split: (e) => <SplitProposal epic={e} projectId={project.id} />,
              hire: (h) => <HireCard hire={h} projectId={project.id} resolved={resolved} />,
            },
          })}
        />
        {tab === 'messages' && (
          <Messages
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
            project={project}
            tickets={data.tickets}
            routes={data.routes}
            findings={data.findings}
            epics={data.epics}
            agents={data.agents}
          />
        )}
        {tab === 'team' && <Team project={project} agents={data.agents} tickets={data.tickets} hires={data.hires} />}
        {tab === 'memory' && <Memory project={project} />}

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
