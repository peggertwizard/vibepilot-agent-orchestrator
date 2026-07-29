import { useState } from 'react'
import type { Attachment, Project } from '@shared/types'
import { Button, Tabs, type TabDef } from '../components/ui'
import { Icon } from '../components/ui/Icon'
import { NeedsYouDot } from '../components/ui/Blueprint'
import type { ProjectData } from '../stores/useProjectData'
import { Messages } from './Messages'
import { Board } from './Board'
import { Memory } from './Memory'
import { Team } from './Team'

type CentreTab = 'messages' | 'board' | 'team' | 'memory'

/** Stable identity, so an empty attachment list does not remount the composer. */
const EMPTY_ATTACHMENTS: Attachment[] = []

export function CentrePane({
  project,
  data,
  model,
  onModelChange,
}: {
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
  const ready = live.filter((t) => t.readyToMerge).length
  const waiting = data.questions.length + data.drafts.length

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
              onClick={() => setTab('messages')}
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
          ) : (
            <span className="meta">nothing waiting on you</span>
          )}
        </div>

        <div style={{ marginTop: 14 }}>
          <Tabs tabs={tabs} active={tab} onChange={setTab} />
        </div>
      </header>

      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
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
