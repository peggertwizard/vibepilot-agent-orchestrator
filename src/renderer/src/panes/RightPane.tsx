import { useCallback, useEffect, useState } from 'react'
import type {
  Agent,
  BranchOverview,
  GhStatus,
  Project,
  Question,
  Ticket,
  WorktreeInfo,
} from '@shared/types'
import { LIVE_STATUSES, formatTokens, prettyModel, tokenBreakdown, totalTokens } from '@shared/types'
import { Avatar, Button, Empty, Meter, SectionRule, Tabs, Tag, type TabDef } from '../components/ui'
import { NeedsYouDot, WorkingBars } from '../components/ui/Blueprint'
import { Icon } from '../components/ui/Icon'
import type { ActivityRow, ProjectData } from '../stores/useProjectData'
import { WatchDrawer } from '../components/WatchDrawer'

/** Stable identity, so an agent with no activity yet does not remount the drawer. */
const EMPTY_ROWS: ActivityRow[] = []

type RightTab = 'agents' | 'branches'

export function RightPane({ project, data }: { project: Project; data: ProjectData }) {
  const [tab, setTab] = useState<RightTab>('agents')
  // Pinned deliberately: you open this to watch one thing to completion. Clicking someone
  // else in the rail switches it, explicitly.
  const [watching, setWatching] = useState<string | null>(null)
  const watched = watching ? (data.agents.find((a) => a.id === watching) ?? null) : null

  const working = data.agents.filter((a) => LIVE_STATUSES.includes(a.status))
  const idle = data.agents.filter((a) => !LIVE_STATUSES.includes(a.status))
  const ready = data.tickets.filter((t) => !t.archivedAt && t.readyToMerge)
  // Tokens, not dollars: a subscription is not billed per token, so the currency figure was
  // notional. Tokens are what the rate limit actually counts — weighted, because a raw sum
  // counts the same cached conversation once per API round-trip.
  const tokens = data.agents.reduce((n, a) => n + totalTokens(a), 0)
  const rawTotals = data.agents.reduce(
    (t, a) => ({
      tokensIn: t.tokensIn + a.tokensIn,
      tokensOut: t.tokensOut + a.tokensOut,
      tokensCacheRead: t.tokensCacheRead + a.tokensCacheRead,
      tokensCacheWrite: t.tokensCacheWrite + a.tokensCacheWrite,
    }),
    { tokensIn: 0, tokensOut: 0, tokensCacheRead: 0, tokensCacheWrite: 0 }
  )

  // A "Files" tab lived here whose own empty state admitted the feature did not exist —
  // there was no files: or fs: IPC channel anywhere in the app. Two working tabs beat three
  // with one lying. What it gestured at (which files a ticket touched) belongs on the ticket.
  const tabs: TabDef<RightTab>[] = [
    { id: 'agents', label: 'Agents', count: data.agents.length || null },
    // Was "Ready", which was fully wired and permanently empty: mark_ready_to_merge had
    // never been called once, and route completion wrote lane 'done' directly, going round the
    // queue entirely. It is Branches now — one place that answers "where is all the work".
    { id: 'branches', label: 'Branches', badge: ready.length || null },
  ]

  return (
    <aside
      style={{
        width: 306,
        flex: 'none',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--pane)',
        minHeight: 0,
        position: 'relative',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '9px 12px',
          borderBottom: '1px solid var(--line)',
          flex: 'none',
        }}
      >
        <WorkingBars
          style={{
            color: working.length ? 'var(--accent)' : 'var(--color-neutral-400)',
            height: 8,
          }}
        />
        <span style={{ font: '400 10.5px var(--font-heading)', color: 'var(--ink-2)' }}>
          {working.length ? `${working.length} working` : 'nothing running'}
          {idle.length > 0 && ` · ${idle.length} idle`}
        </span>
        <div style={{ flex: 1 }} />
        {tokens > 0 && (
          <span
            className="meta tnum"
            title={`What this project has cost against your rate limit.\n\n${tokenBreakdown(rawTotals)}`}
          >
            {formatTokens(tokens)} tok
          </span>
        )}
      </div>

      {data.quotaResetsAt && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '7px 12px',
            background: 'var(--warn-soft)',
            borderBottom: '1px solid var(--line)',
            font: '400 10.5px var(--font-heading)',
            color: 'var(--danger)',
          }}
        >
          <Icon name="warn" size={12} />
          <span>
            Rate limited — resets{' '}
            {new Date(data.quotaResetsAt).toLocaleTimeString(undefined, {
              hour: '2-digit',
              minute: '2-digit',
            })}
          </span>
        </div>
      )}

      <Tabs tabs={tabs} active={tab} onChange={setTab} variant="caps" />

      <div className="scroll-y" style={{ flex: 1, minHeight: 0, padding: 10 }}>
        {tab === 'agents' && (
          <AgentsList
            working={working}
            idle={idle}
            agents={data.agents}
            tickets={data.tickets}
            questions={data.questions}
            onWatch={(a) => setWatching(a.id)}
          />
        )}

        {tab === 'branches' && (
          <BranchesTab tickets={ready} agents={data.agents} project={project} />
        )}
      </div>

      {watched && (
        <WatchDrawer
          agent={watched}
          ticket={data.tickets.find((t) => t.id === watched.currentTicketId) ?? null}
          rows={data.activity[watched.id] ?? EMPTY_ROWS}
          live={data.live[watched.id] ?? null}
          projectId={project.id}
          onClose={() => setWatching(null)}
        />
      )}
    </aside>
  )
}

function AgentsList({
  working,
  idle,
  agents,
  tickets,
  questions,
  onWatch,
}: {
  working: Agent[]
  idle: Agent[]
  /** Everyone, not just this section — the Pilot's line is derived from what others are doing. */
  agents: Agent[]
  tickets: Ticket[]
  questions: Question[]
  onWatch: (a: Agent) => void
}) {
  if (working.length === 0 && idle.length === 0) {
    return (
      <Empty
        title="No agents"
        hint="The Pilot starts when you send your first message. Teammates show up here as it hires them."
      />
    )
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {working.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <SectionRule label="Working" count={working.length} />
          {working.map((a) => (
            <AgentRow
              key={a.id}
              agent={a}
              agents={agents}
              tickets={tickets}
              questions={questions}
              onWatch={onWatch}
            />
          ))}
        </div>
      )}
      {idle.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <SectionRule label="Idle" count={idle.length} />
          {idle.map((a) => (
            <AgentRow
              key={a.id}
              agent={a}
              agents={agents}
              tickets={tickets}
              questions={questions}
              dim
              onWatch={onWatch}
            />
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * What the Pilot is waiting for, worked out from the board rather than asked for.
 *
 * The Pilot's status used to be the name of the last tool it called, and once it delegated it
 * had nothing to do — so `bash` sat there for as long as the teammate ran and the app looked
 * idle while it was in fact blocked. Everything needed to say something true is already on
 * screen: who is working, on which ticket, and whether a question is open.
 *
 * Deliberately derived and never stored. A written status line goes stale the moment the board
 * moves; this cannot.
 */
function waitingLine(agent: Agent, agents: Agent[], tickets: Ticket[], questions: Question[]): string | null {
  if (!agent.isPilot) return null
  if (agent.status !== 'idle') return null

  // Blocked on you outranks blocked on a teammate: only one of them will unblock itself.
  const mine = questions.filter((q) => q.status === 'open')
  if (mine.length) {
    const asker = agents.find((a) => a.id === mine[0]!.agentId)
    return mine.length === 1
      ? `Waiting on your call — ${asker?.name ?? 'someone'} asked you a question`
      : `Waiting on your call — ${mine.length} questions open`
  }

  const busy = agents.filter(
    (a) => !a.isPilot && ['working', 'thinking', 'starting', 'queued'].includes(a.status),
  )
  if (busy.length === 0) return null

  if (busy.length === 1) {
    const who = busy[0]!
    const t = tickets.find((x) => x.id === who.currentTicketId)
    return t ? `Waiting on ${who.name} — #${t.number} ${t.title}` : `Waiting on ${who.name}`
  }
  return `Waiting on ${busy.map((a) => a.name).join(', ')}`
}

function AgentRow({
  agent,
  agents,
  tickets,
  questions,
  dim,
  onWatch,
}: {
  agent: Agent
  agents: Agent[]
  tickets: Ticket[]
  questions: Question[]
  dim?: boolean
  onWatch: (a: Agent) => void
}) {
  const ticket = tickets.find((t) => t.id === agent.currentTicketId) ?? null
  const waiting = agent.status === 'waiting_on_you'
  const bad = agent.status === 'error' || agent.status === 'stalled'
  // The derived line wins over a stored one, because the stored one is from the last thing
  // the Pilot said it was doing and it has since stopped doing it.
  const derived = waitingLine(agent, agents, tickets, questions)

  return (
    <div
      style={{
        border: `1px solid ${bad ? 'var(--danger)' : dim ? 'var(--line-2)' : 'var(--line)'}`,
        background: dim ? 'transparent' : 'var(--surface)',
        padding: '9px 10px',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <Avatar
          initials={agent.avatarInitials}
          seed={agent.id}
          size={22}
          isPilot={agent.isPilot}
          dim={dim}
        />
        <button
          onClick={() => onWatch(agent)}
          title={`Watch what ${agent.name} is doing`}
          className="ellip"
          style={{
            flex: 1,
            minWidth: 0,
            textAlign: 'left',
            border: 'none',
            background: 'transparent',
            padding: 0,
            fontSize: 12.5,
            fontWeight: 600,
            color: 'inherit',
            cursor: 'pointer',
          }}
        >
          {agent.name}
        </button>
        {waiting && <NeedsYouDot />}
        {agent.status === 'working' || agent.status === 'thinking' ? (
          <WorkingBars style={{ color: 'var(--accent)', height: 9 }} />
        ) : null}
        <Tag tone={bad ? 'danger' : 'neutral'}>
          {prettyModel(agent.resolvedModel, agent.model)}
        </Tag>
      </div>

      <div
        className="ellip"
        style={{
          fontSize: 11.5,
          lineHeight: 1.5,
          color: bad ? 'var(--danger)' : 'var(--muted)',
        }}
        title={derived ?? agent.statusLine ?? agent.status}
      >
        {derived ?? agent.statusLine ?? statusWord(agent.status)}
      </div>

      {/* Context headroom. Unknown until a turn completes, so it appears rather than
          showing a misleading zero. */}
      {agent.contextMax != null && agent.contextUsed != null && (
        <div
          title={`${agent.contextUsed.toLocaleString()} of ${agent.contextMax.toLocaleString()} tokens of context in use`}
        >
          <Meter
            label="ctx"
            pct={(agent.contextUsed / agent.contextMax) * 100}
            right={
              <span className="meta tnum" style={{ flex: 'none' }}>
                {formatTokens(agent.contextUsed)}/{formatTokens(agent.contextMax)}
              </span>
            }
          />
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        {ticket && <span className="meta tnum">#{ticket.number}</span>}
        <div style={{ flex: 1 }} />
        {totalTokens(agent) > 0 && (
          <span className="meta tnum" title={tokenBreakdown(agent)}>
            {formatTokens(totalTokens(agent))} tok
          </span>
        )}
        {(agent.status === 'working' || agent.status === 'thinking') && (
          <button
            onClick={() => void window.vibepilot.agents.stop(agent.id)}
            title="Kills the process — the current turn is lost"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 3,
              border: 'none',
              background: 'transparent',
              color: 'var(--faint)',
              font: '400 10px var(--font-heading)',
              textTransform: 'uppercase',
              letterSpacing: '.06em',
            }}
          >
            <Icon name="stop" size={11} />
            stop
          </button>
        )}
      </div>
    </div>
  )
}

/**
 * Where all the work is.
 *
 * Three sections answering three different questions: **where am I**, **what have my agents
 * got**, **what have I finished but not shipped**. All of it from local git — `rev-parse`,
 * `rev-list`, `branch` — so it cannot fail when the wifi drops, which matters because
 * vibePilot's own repository has no remote at all.
 *
 * GitHub is a fourth section that only appears when you press for it. Optional in every
 * direction: no remote, no `gh`, not logged in, offline. Each of those makes it absent and
 * changes nothing else — that is what keeps a local-first app from acquiring a network
 * dependency by accident.
 */
function BranchesTab({
  tickets,
  agents,
  project,
}: {
  tickets: Ticket[]
  agents: Agent[]
  project: Project
}) {
  const [ov, setOv] = useState<BranchOverview | null>(null)
  const [gh, setGh] = useState<GhStatus | null>(null)
  const [trees, setTrees] = useState<WorktreeInfo[]>([])
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  const load = useCallback(() => {
    void window.vibepilot.git.overview(project.id).then(setOv)
    void window.vibepilot.git.worktrees(project.id).then(setTrees)
  }, [project.id])

  useEffect(load, [load])

  const push = async (): Promise<void> => {
    setBusy(true)
    setNote(null)
    const r = await window.vibepilot.git.push(project.id)
    setNote(r.ok ? 'Pushed to origin.' : (r.reason ?? 'Nothing was pushed.'))
    setBusy(false)
    load()
  }

  const removable = trees.filter((t) => t.safeToRemove)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Where am I */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
        <SectionRule label="You are here" />
        <Row name={ov?.current ?? '—'} right={<span className="meta">current</span>} strong />
        {ov && ov.diverged && (
          <Row name={ov.base} right={<span className="meta">merges land here</span>} />
        )}
        {ov?.remote && (
          <div className="meta" style={{ paddingLeft: 2, lineHeight: 1.5 }}>
            {ov.remote.upstream
              ? `${ov.remote.upstream} · ${ov.remote.ahead} ahead, ${ov.remote.behind} behind`
              : `${ov.base} has never been pushed`}
          </div>
        )}
      </div>

      {/* What have my agents got */}
      {ov && ov.ticketBranches.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          <SectionRule label="Ticket branches" count={ov.ticketBranches.length} />
          {ov.ticketBranches.map((b) => (
            <Row
              key={b.name}
              name={b.name}
              right={
                <span className="meta tnum">
                  {b.ahead === 0 ? 'nothing to merge' : `↑${b.ahead}`}
                </span>
              }
            />
          ))}
        </div>
      )}

      {/* What have I finished but not shipped */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <SectionRule label="Waiting for you" count={tickets.length || null} />
        <ReadyList
          tickets={tickets}
          agents={agents}
          projectId={project.id}
          baseBranch={project.defaultBaseBranch}
          unsaved={ov?.unsaved ?? []}
          onDone={load}
        />
      </div>

      {/*
        Push exists only when there is somewhere to push. It sends the BASE branch and never
        agent branches: the finished result leaves the machine, the working copies do not.
      */}
      {ov?.remote && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <SectionRule label="Merged, not pushed" />
          <Button
            height={27}
            full
            disabled={busy}
            onClick={() => void push()}
            title={`Pushes ${ov.base} to origin. Agent branches never leave your machine.`}
          >
            {busy ? 'Pushing…' : `Push ${ov.base}`}
          </Button>
          {note && (
            <div className="meta selectable" style={{ lineHeight: 1.5, color: 'var(--ink-2)' }}>
              {note}
            </div>
          )}
        </div>
      )}

      {/*
        Working copies. `removeWorktree`, `pruneWorktrees` and `listWorktrees` all existed with
        zero callers and a comment referring to "the reaper" as though it were real. It was not:
        every ticket left a full copy of the project on the system drive, forever.
      */}
      {removable.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          <SectionRule label="Working copies you can free" count={removable.length} />
          {removable.map((w) => (
            <div key={w.path} style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              <span className="meta mono ellip" style={{ flex: 1 }} title={w.path}>
                {w.branch ?? w.path}
              </span>
              <span className="meta tnum">{Math.max(1, Math.round(w.bytes / 1024 / 1024))} MB</span>
              <Button
                height={22}
                onClick={() => {
                  void window.vibepilot.git.removeWorktree(project.id, w.path).then(load)
                }}
              >
                Remove
              </Button>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <SectionRule label="GitHub" />
        {gh === null ? (
          <Button
            height={25}
            full
            onClick={() => void window.vibepilot.git.github(project.id).then(setGh)}
          >
            Check GitHub
          </Button>
        ) : !gh.available ? (
          <div className="meta" style={{ lineHeight: 1.5, color: 'var(--faint)' }}>
            {gh.reason} Everything else here is local and works without it.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {gh.pullRequests.length === 0 && gh.runs.length === 0 && (
              <span className="meta" style={{ color: 'var(--faint)' }}>
                No open pull requests or recent runs.
              </span>
            )}
            {gh.pullRequests.map((pr) => (
              <Row
                key={pr.number}
                name={`#${pr.number} ${pr.title}`}
                right={<Tag tone="neutral">{pr.state.toLowerCase()}</Tag>}
              />
            ))}
            {gh.runs.map((r, i) => (
              <Row
                key={`${r.name}-${i}`}
                name={r.name}
                right={
                  <Tag tone={r.conclusion === 'failure' ? 'danger' : 'neutral'}>
                    {r.conclusion || r.status}
                  </Tag>
                }
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

/** One line: a name that truncates, and something short on the right. */
function Row({
  name,
  right,
  strong,
}: {
  name: string
  right?: React.ReactNode
  strong?: boolean
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
      <span
        className="ellip mono"
        style={{ flex: 1, fontSize: 11.5, fontWeight: strong ? 600 : 400 }}
        title={name}
      >
        {name}
      </span>
      {right}
    </div>
  )
}

function ReadyList({
  tickets,
  agents,
  projectId,
  baseBranch,
  unsaved,
  onDone,
}: {
  tickets: Ticket[]
  agents: Agent[]
  projectId: string
  baseBranch: string
  unsaved: string[]
  onDone: () => void
}) {
  if (tickets.length === 0) {
    return (
      <div className="meta" style={{ color: 'var(--faint)', lineHeight: 1.5 }}>
        Nothing waiting to merge.
      </div>
    )
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {tickets.map((t) => {
        const who = agents.find((a) => a.id === t.assigneeAgentId)
        return (
          <div
            key={t.id}
            style={{
              border: '1px solid var(--line)',
              background: 'var(--surface)',
              padding: '10px 11px',
              display: 'flex',
              flexDirection: 'column',
              gap: 7,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 7 }}>
              <span className="meta tnum">#{t.number}</span>
              {t.mergeState === 'conflict' && <Tag tone="danger">conflict</Tag>}
              <div style={{ flex: 1 }} />
              {who && <span className="meta">{who.name}</span>}
            </div>
            <div style={{ fontSize: 12.5, fontWeight: 500, lineHeight: 1.45 }}>{t.title}</div>
            {t.branch && <span className="meta mono ellip">{t.branch}</span>}
            <MergeButton
              projectId={projectId}
              ticket={t}
              baseBranch={baseBranch}
              unsaved={unsaved}
              onDone={onDone}
            />
          </div>
        )
      })}
    </div>
  )
}

/**
 * Merging, said before it happens rather than explained after it fails.
 *
 * The old version offered one button whatever the state of your folder, so pressing it with
 * unsaved work got you a red error that named a thing you had not done wrong. Everything needed
 * to know better is read from git a moment earlier — so when there is something in the way, the
 * card says what, in words, and offers to handle it.
 */
function MergeButton({
  projectId,
  ticket,
  baseBranch,
  unsaved,
  onDone,
}: {
  projectId: string
  ticket: Ticket
  baseBranch: string
  /** Your own uncommitted work, by name. Empty means this is one uneventful press. */
  unsaved: string[]
  onDone: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const merge = async (setAside = false) => {
    setBusy(true)
    setError(null)
    const r = await window.vibepilot.git.merge(projectId, ticket.id, setAside)
    if (!r.ok) setError(r.reason ?? 'The merge did not complete.')
    setBusy(false)
    onDone()
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {error && (
        <div
          className="selectable"
          style={{
            fontSize: 11,
            lineHeight: 1.5,
            color: 'var(--danger)',
            borderLeft: '2px solid var(--danger)',
            paddingLeft: 8,
          }}
        >
          {error}
        </div>
      )}
      {ticket.conflictFiles.length > 0 && (
        <div className="mono" style={{ fontSize: 10, color: 'var(--danger)' }}>
          {ticket.conflictFiles.slice(0, 4).map((f) => (
            <div key={f} className="ellip">
              {f}
            </div>
          ))}
        </div>
      )}
      {unsaved.length > 0 ? (
        <>
          {/*
            Plain words, and the specific files. "Uncommitted changes" is a phrase you have to
            already know; "you have unsaved work in your project folder" is not, and the names
            turn an abstract warning into something recognisable.
          */}
          <div style={{ fontSize: 11.5, lineHeight: 1.55, color: 'var(--ink-2)' }}>
            You have unsaved work in your project folder. Merging on top of it would mix it with{' '}
            {ticket.branch ? 'the agent\u2019s changes' : 'the agent\u2019s work'}.
          </div>
          <div className="mono" style={{ fontSize: 10, color: 'var(--muted)' }}>
            {unsaved.slice(0, 4).map((f) => (
              <div key={f} className="ellip" title={f}>
                {f}
              </div>
            ))}
            {unsaved.length > 4 && <div>and {unsaved.length - 4} more</div>}
          </div>
          <Button
            kind="primary"
            height={27}
            full
            disabled={busy || !ticket.branch}
            onClick={() => void merge(true)}
            title={
              'Puts your unsaved work safely to one side, merges, and puts it straight back. ' +
              'Nothing of yours is committed or thrown away.'
            }
          >
            {busy ? 'Merging\u2026' : 'Set my work aside and merge'}
          </Button>
          <div className="meta" style={{ color: 'var(--faint)', lineHeight: 1.5 }}>
            Nothing of yours is committed or thrown away \u2014 it comes straight back
            afterwards. Or commit it yourself first and this turns into a plain merge.
          </div>
        </>
      ) : (
        <Button
          kind="primary"
          height={27}
          full
          disabled={busy || !ticket.branch}
          onClick={() => void merge()}
          title={
            ticket.branch
              ? `Brings ${ticket.branch} into ${baseBranch} as one commit, on this machine. Nothing is pushed.`
              : 'No branch to merge'
          }
        >
          {busy ? 'Merging\u2026' : `Merge into ${baseBranch}`}
        </Button>
      )}
    </div>
  )
}

function statusWord(s: Agent['status']): string {
  switch (s) {
    case 'waiting_on_you':
      return 'waiting for your answer'
    case 'stalled':
      return 'stalled — restart it'
    case 'queued':
      return 'queued'
    case 'starting':
      return 'starting up'
    default:
      return s
  }
}
